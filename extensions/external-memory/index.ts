/**
 * Synced-folder external-memory extension for Pi.
 *
 * Captures selected conversation evidence into immutable JSONL chunks under a
 * user-selected synchronized directory at compaction, explicit capture, and
 * session-shutdown boundaries. Recall is lazy and two-stage (checkpoints first,
 * referenced archives second) with provenance on every result.
 *
 * Capture is opt-in per project. Without PI_AGENT_MEMORY_ROOT or project
 * opt-in, no files are written and no tool is activated.
 *
 * All failures are fail-open: capture never cancels Pi compaction and never
 * blocks session shutdown indefinitely.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  loadExternalMemoryConfig,
  resolveProviderFromEnv,
  resolveRootFromEnv,
  writeProjectConfig,
} from "./config.ts";
import { sessionEntryToSource } from "./content-policy.ts";
import { ExternalMemory } from "./external-memory.ts";
import { latestEntryTimestamp } from "./session-snapshot.ts";
import { SyncedFolderStore } from "./synced-folder-store.ts";
import type { MemoryEvidence, SessionSnapshot, SourceEntry } from "./types.ts";

const SHUTDOWN_CAPTURE_DEADLINE_MS = 5_000;

interface MemoryRuntime {
  memory: ExternalMemory | undefined;
  root: string | undefined;
  enabled: boolean;
  notifiedOnce: boolean;
}

/** Registered once per module load; `pi.registerTool` dedupes by name. */
let memoryToolRegistered = false;

/** Test seam: clear the once-per-module tool registration flag. */
export function resetMemoryToolRegistration(): void {
  memoryToolRegistered = false;
}

export default function externalMemoryExtension(pi: ExtensionAPI): void {
  const runtime: MemoryRuntime = {
    memory: undefined,
    root: undefined,
    enabled: false,
    notifiedOnce: false,
  };

  const debug = (message: string): void => {
    if (process.env.PI_AGENT_MEMORY_DEBUG) console.error(`[external-memory] ${message}`);
  };

  /** (Re)initialize the runtime from environment + project config. Fail-open. */
  const initialize = async (ctx: ExtensionContext): Promise<void> => {
    const resolved = await loadExternalMemoryConfig(ctx.cwd);

    if (!resolved.configured || !resolved.root || !resolved.project || !resolved.projectKey) {
      runtime.memory = undefined;
      runtime.root = undefined;
      runtime.enabled = false;
      if (!runtime.notifiedOnce && ctx.hasUI) {
        runtime.notifiedOnce = true;
        const hint = resolved.reason === "missing-root"
          ? "set PI_AGENT_MEMORY_ROOT to an absolute path to enable."
          : "run /memory on in a project you trust to enable.";
        ctx.ui.notify(`External memory disabled: ${hint}`, "info");
      }
      return;
    }

    if (!resolved.project.enabled) {
      runtime.memory = undefined;
      runtime.root = resolved.root;
      runtime.enabled = false;
      if (!runtime.notifiedOnce && ctx.hasUI) {
        runtime.notifiedOnce = true;
        ctx.ui.notify(
          "External memory is configured but disabled here. Run /memory on to enable.",
          "info",
        );
      }
      return;
    }

    const changed =
      !runtime.memory ||
      runtime.root !== resolved.root ||
      runtime.memory.config.project.projectId !== resolved.projectKey;
    if (changed) {
      // Effective project key is fixed into the config so storage directories
      // and archive headers always agree (project isolation).
      const config = {
        root: resolved.root,
        provider: resolved.provider,
        project: { ...resolved.project, projectId: resolved.projectKey },
      };
      runtime.memory = new ExternalMemory(config, new SyncedFolderStore(resolved.root));
      runtime.memory.onDiag = debug;
    }
    runtime.root = resolved.root;
    runtime.enabled = true;
    // The recall tool becomes active as soon as memory is enabled (also after
    // an explicit /memory on); registration is idempotent per module load.
    registerMemoryTool();

    // Bounded write probe; local success is not a claim of cloud sync.
    try {
      const probed = await runtime.memory.status();
      if (!probed.localWritable && !runtime.notifiedOnce && ctx.hasUI) {
        runtime.notifiedOnce = true;
        ctx.ui.notify(
          "External memory root is not writable. Capture is disabled this session.",
          "warning",
        );
      }
    } catch {
      runtime.notifiedOnce = true;
    }
    if (!runtime.notifiedOnce && ctx.hasUI) {
      runtime.notifiedOnce = true;
      ctx.ui.notify(
        `External memory enabled (synced folder: ${resolved.root}).`,
        "info",
      );
    }
  };

  /**
   * Build a capture snapshot from the current session branch. Never throws.
   * `entries` may be supplied by the caller (e.g. the authoritative
   * `session_before_compact` branchEntries); otherwise the active branch is
   * read from the session manager. Pi's getBranch() is oldest-first, matching
   * the snapshot contract.
   */
  const snapshotFromContext = (
    ctx: ExtensionContext,
    reason: SessionSnapshot["reason"],
    entriesOverride?: unknown[],
  ): SessionSnapshot | undefined => {
    const memory = runtime.memory;
    if (!memory || !runtime.enabled) return undefined;
    const projectKey = memory.config.project.projectId;
    if (!projectKey) return undefined;
    const sm = ctx.sessionManager;
    const branch = entriesOverride ?? (sm.getBranch(sm.getLeafId() ?? undefined) ?? []); // oldest first
    const entries: SourceEntry[] = [];
    for (const raw of branch) {
      const source = sessionEntryToSource(raw);
      if (source) entries.push(source);
    }
    const timestamp = latestEntryTimestamp(entries);
    return {
      sessionId: sm.getSessionId() ?? "ephemeral",
      branchId: sm.getLeafId() ?? "branch",
      projectKey,
      entries,
      reason,
      timestamp,
    };
  };

  /**
   * Capture with fail-open behavior; never throws into Pi lifecycle.
   * When a deadline is set, shutdown proceeds after it; the capture promise
   * keeps running in the background (best-effort, immutable writes only) and
   * any partial temp file is ignored and cleaned during a later pass.
   */
  const safeCapture = async (
    ctx: ExtensionContext,
    reason: SessionSnapshot["reason"],
    options?: { deadlineMs?: number; entries?: unknown[] },
  ): Promise<void> => {
    const memory = runtime.memory;
    if (!memory || !runtime.enabled) return;
    const snapshot = snapshotFromContext(ctx, reason, options?.entries);
    if (!snapshot || snapshot.entries.length === 0) return;
    const boundedCapture = memory.capture(snapshot);
    let settled: Promise<void> = boundedCapture as unknown as Promise<void>;
    if (options?.deadlineMs) {
      const timer = new Promise<void>((resolve) =>
        setTimeout(() => {
          debug(`${reason} capture deadline elapsed; capture continues in background.`);
          resolve();
        }, options.deadlineMs!),
      );
      settled = Promise.race([boundedCapture as unknown as Promise<void>, timer]);
    }
    try {
      await settled;
    } catch (error) {
      debug(`${reason} capture failed: ${bounded(error)}`);
    } finally {
      memory.invalidateCache();
    }
  };

  /** Write a checkpoint after a successful Pi compaction. Fail-open. */
  const safeCheckpoint = async (
    ctx: ExtensionContext,
    event: {
      compactionEntry: { id: string; summary: string; firstKeptEntryId: string };
      reason: "manual" | "threshold" | "overflow";
      willRetry: boolean;
    },
  ): Promise<void> => {
    const memory = runtime.memory;
    if (!memory || !runtime.enabled) return;
    const sm = ctx.sessionManager;
    const projectKey = memory.config.project.projectId;
    if (!projectKey) return;
    const sessionId = sm.getSessionId() ?? "ephemeral";
    const dir = projectSessionDir(projectKey, sessionId);

    try {
      const archives = await memory.store.discoverArchives(dir);
      const fileNameList = archives.map((archive) => archive.fileName).sort();
      const result = await memory.writeCheckpoint(sessionId, projectKey, {
        compactionEntryId: event.compactionEntry.id,
        reason: event.reason,
        willRetry: event.willRetry,
        summary: event.compactionEntry.summary,
        sourceRange: archiveRange(archives),
        archiveFiles: fileNameList,
        firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
      });
      if (result.checkpointsCreated.length > 0) {
        debug(`checkpoint written for ${event.compactionEntry.id}.`);
      }
    } catch (error) {
      debug(`checkpoint failed: ${bounded(error)}`);
    }
  };

  const registerMemoryTool = (): void => {
    if (memoryToolRegistered) return;
    memoryToolRegistered = true;
    pi.registerTool({
      name: "memory_recall",
      label: "Recall external memory",
      description:
        "Recall evidence from earlier sessions stored in external memory. Use when the current task depends on decisions or facts from earlier sessions that are not present in the current context. Returns bounded excerpts with provenance.",
      promptSnippet: "Recall earlier-session evidence when a task depends on past decisions or facts",
      parameters: Type.Object({
        query: Type.String({ description: "Search terms (text, symbols, paths)" }),
        max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        max_characters: Type.Optional(
          Type.Integer({ minimum: 512, maximum: 100_000 }),
        ),
        since: Type.Optional(Type.String({ description: "ISO timestamp; only recall evidence at or after this" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const memory = runtime.memory;
        if (!memory || !runtime.enabled) {
          return {
            content: [{ type: "text", text: "External memory is not enabled for this project." }],
            details: { enabled: false },
          };
        }
        const results = await memory.recall({
          query: params.query,
          maxResults: params.max_results,
          maxCharacters: params.max_characters,
          since: params.since,
        });
        return {
          content: [{ type: "text", text: renderRecallResults(results) }],
          details: { enabled: true, resultCount: results.length },
        };
      },
    });
  };

  // --- Lifecycle wiring ----------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    await initialize(ctx);
    // The recall tool is only active once memory is enabled for the project.
    if (runtime.enabled) registerMemoryTool();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!runtime.memory || !runtime.enabled) return undefined;
    // Use the event's authoritative branch (the one Pi is about to summarize)
    // rather than re-reading the session manager.
    await safeCapture(ctx, event.reason, { entries: event.branchEntries });
    // Returning undefined leaves Pi's compaction untouched (fail-open).
    return undefined;
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!runtime.memory || !runtime.enabled) return;
    await safeCheckpoint(ctx, event);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!runtime.memory || !runtime.enabled) return;
    await safeCapture(ctx, "shutdown", { deadlineMs: SHUTDOWN_CAPTURE_DEADLINE_MS });
  });

  // --- /memory commands ----------------------------------------------------

  pi.registerCommand("memory", {
    description: "Manage external memory: status, search <query>, capture, on, off",
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/);
      const query = rest.join(" ").trim();
      switch (action) {
        case "status":
          if (runtime.memory) {
            ctx.ui.notify(await renderStatusText(await runtime.memory.status()), "info");
          } else {
            ctx.ui.notify(await statusFallbackText(ctx), "info");
          }
          return;
        case "search":
          if (!runtime.memory || !runtime.enabled) {
            ctx.ui.notify("External memory is not enabled. Run /memory on to enable.", "info");
            return;
          }
          if (!query) {
            ctx.ui.notify("Usage: /memory search <terms>", "info");
            return;
          }
          {
            const results = await runtime.memory.recall({ query, maxResults: 5 });
            ctx.ui.notify(
              results.length === 0
                ? `No external memory matched “${query}”.`
                : renderRecallResults(results),
              "info",
            );
          }
          return;
        case "capture":
          if (!runtime.memory || !runtime.enabled) {
            ctx.ui.notify("External memory is not enabled. Run /memory on to enable.", "warning");
            return;
          }
          await safeCapture(ctx, "explicit");
          ctx.ui.notify("External memory capture finished.", "info");
          return;
        case "on":
          await enableMemory(ctx, runtime, initialize);
          return;
        case "off":
          await disableMemory(ctx, runtime);
          return;
        default:
          ctx.ui.notify(usageText(), "info");
          return;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers (pure; unit-testable)
// ---------------------------------------------------------------------------

export function projectSessionDir(projectKey: string, sessionId: string): string {
  return `v1/projects/${projectKey}/sessions/${sessionId}`;
}

export function archiveRange(
  archives: readonly { header: { firstEntryId: string; lastEntryId: string } }[],
): { firstEntryId: string; lastEntryId: string } {
  if (archives.length === 0) {
    return { firstEntryId: "none", lastEntryId: "none" };
  }
  const sorted = [...archives].sort((a, b) =>
    a.header.firstEntryId.localeCompare(b.header.firstEntryId),
  );
  return {
    firstEntryId: sorted[0].header.firstEntryId,
    lastEntryId: sorted[sorted.length - 1].header.lastEntryId,
  };
}

export function renderStatusText(
  status: Awaited<ReturnType<ExternalMemory["status"]>>,
): string {
  const lines = [
    `External memory: ${status.enabled ? "enabled" : "disabled"}`,
    `Root: ${status.root ?? "(none)"}`,
    `Provider hint: ${status.provider ?? "(none)"}`,
    `Local writable: ${status.localWritable ? "yes" : "no"}`,
    `Cloud sync state: ${status.cloudSynced}`,
    `Archives: ${status.libraries.archiveFiles}`,
    `Checkpoints: ${status.libraries.checkpointFiles}`,
    `Stale temp files: ${status.libraries.staleTemporaryFiles}`,
  ];
  if (status.provider && status.provider !== "filesystem") {
    lines.push("Local writes are not proof of cloud synchronization.");
  }
  return lines.join("\n");
}

export function renderRecallResults(results: MemoryEvidence[]): string {
  if (results.length === 0) return "No matching external memory found.";
  return results
    .map((result) => {
      const provenance = [
        `project=${result.projectKey}`,
        `session=${result.sessionId}`,
        `archive=${result.archiveFile}`,
        `entries=${result.sourceEntryIds.join(",")}`,
        result.sourceTime ? `time=${result.sourceTime}` : `time=?`,
        `content=${result.complete ? "complete" : "excerpted"}`,
      ].join(" ");
      return `${result.kind === "checkpoint" ? "[checkpoint]" : "[evidence]"} ${
        result.content
      }\n— ${provenance}`;
    })
    .join("\n---\n");
}

async function statusFallbackText(ctx: ExtensionContext): Promise<string> {
  const root = resolveRootFromEnv();
  if (!root) {
    return "External memory is disabled: PI_AGENT_MEMORY_ROOT is not set.\nSet it to an absolute path, then run /memory on in a project you trust.";
  }
  const resolved = await loadExternalMemoryConfig(ctx.cwd);
  if (resolved.reason === "not-opted-in") {
    return `External memory root is configured (${root}) but this project has not opted in.\nRun /memory on to enable capture for this project.`;
  }
  const provider = resolveProviderFromEnv();
  return `External memory root: ${root}${provider ? ` (provider hint: ${provider})` : ""}`;
}

async function enableMemory(
  ctx: ExtensionContext,
  runtime: MemoryRuntime,
  initialize: (ctx: ExtensionContext) => Promise<void>,
): Promise<void> {
  const root = resolveRootFromEnv();
  if (!root) {
    ctx.ui.notify(
      "Cannot enable external memory: set PI_AGENT_MEMORY_ROOT to an absolute path first.",
      "warning",
    );
    return;
  }
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      "Enable external memory?",
      `Write ${ctx.cwd}/.pi/external-memory.json and capture conversation evidence into:\n${root}`,
    );
    if (!ok) {
      ctx.ui.notify("External memory enable cancelled.", "info");
      return;
    }
  }
  await writeProjectConfig(ctx.cwd, { enabled: true });
  runtime.notifiedOnce = false;
  await initialize(ctx);
  ctx.ui.notify("External memory enabled for this project.", "info");
}

async function disableMemory(ctx: ExtensionContext, runtime: MemoryRuntime): Promise<void> {
  await writeProjectConfig(ctx.cwd, { enabled: false });
  runtime.enabled = false;
  runtime.memory = undefined;
  ctx.ui.notify("External memory disabled for this project. Existing memory files were kept.", "info");
}

function usageText(): string {
  return [
    "External memory commands:",
    "  /memory status          Show configuration, writability, and library size",
    "  /memory search <terms>  Recall matching evidence",
    "  /memory capture         Capture the unarchived session tail now",
    "  /memory on              Enable (opt-in) for this project",
    "  /memory off             Disable future capture and recall (keeps files)",
  ].join("\n");
}

function bounded(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
