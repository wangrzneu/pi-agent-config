import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  CONFIG_DIR_NAME,
  createBashToolDefinition,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadSandboxConfig, type LoadedSandboxConfig } from "./config.ts";
import {
  createSandboxedBashOperations,
  SandboxProcessTracker,
  type SandboxCommandRuntime,
} from "./process.ts";
import { SandboxPathAuthorization } from "./path-authorization.ts";
import { ensureSandboxTempRoot, SANDBOX_TEMP_ROOT } from "./sandbox-paths.ts";
import { errorMessage } from "./util.ts";

const STATUS_KEY = "sandbox";

type SandboxMode = "starting" | "sandboxed" | "bypass" | "blocked";

interface SandboxState {
  mode: SandboxMode;
  reason: string;
  loaded?: LoadedSandboxConfig;
}

interface SandboxRuntime extends SandboxCommandRuntime {
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  isSupportedPlatform(): boolean;
  reset(): Promise<void>;
}

export default function sandboxExtension(pi: ExtensionAPI): void {
  registerSandboxExtension(pi, SandboxManager);
}

export interface AuthorizationOptions {
  allowOsTemp?: boolean;
  piReadRoots?: string[];
}

function defaultPiReadRoots(): string[] {
  const agentDir = getAgentDir();
  return [
    "skills",
    "prompts",
    "themes",
    "extensions",
    "git",
    "packages",
  ].map((name) => join(agentDir, name));
}

export function registerSandboxExtension(
  pi: ExtensionAPI,
  runtime: SandboxRuntime,
  authorizationOptions: AuthorizationOptions = {},
): void {
  const tracker = new SandboxProcessTracker();
  const piReadRoots = authorizationOptions.piReadRoots ?? defaultPiReadRoots();
  const authOptions = { ...authorizationOptions, piReadRoots };
  const readAuthorization = new SandboxPathAuthorization(authOptions);
  const writeAuthorization = new SandboxPathAuthorization(authOptions);
  const baseBash = createBashToolDefinition(process.cwd());
  let initialized = false;
  let state: SandboxState = { mode: "starting", reason: "waiting for session start" };
  const operations = createSandboxedBashOperations(runtime, tracker, () => {
    const filesystem = state.loaded?.config.filesystem;
    if (!filesystem) return undefined;
    return {
      filesystem: {
        ...filesystem,
        allowRead: [
          ...(filesystem.allowRead ?? []),
          ...readAuthorization.paths(),
        ],
        allowWrite: [
          ...filesystem.allowWrite,
          ...writeAuthorization.paths(),
        ],
      },
    };
  });

  pi.registerFlag("no-sandbox", {
    description: "Explicitly run local bash commands without OS-level sandboxing",
    type: "boolean",
    default: false,
  });

  registerPathAuthorizationTool(pi, "read", readAuthorization);
  registerPathAuthorizationTool(pi, "write", writeAuthorization);

  pi.registerTool({
    ...baseBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (state.mode === "blocked" || state.mode === "starting") {
        throw new Error(`Sandboxed bash is unavailable: ${state.reason}`);
      }

      const tool = state.mode === "sandboxed"
        ? createBashToolDefinition(ctx.cwd, { operations })
        : createBashToolDefinition(ctx.cwd);
      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (state.mode === "bypass") return;
    const access = fileAccessPath(event.toolName, event.input as Record<string, unknown>);
    if (access === undefined) return;
    const authorization = access.kind === "read" ? readAuthorization : writeAuthorization;
    if (await authorization.isAllowed(access.path, ctx.cwd)) return;
    return {
      block: true,
      reason: `${PATH_ACCESS_META[access.kind].phrase} outside the workspace requires authorization: ${access.path}. Call sandbox_authorize_${access.kind} first.`,
    };
  });

  pi.on("user_bash", () => {
    if (state.mode === "sandboxed") return { operations };
    if (state.mode === "blocked" || state.mode === "starting") {
      return {
        result: {
          output: `Sandboxed bash is unavailable: ${state.reason}`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    state = { mode: "starting", reason: "initializing" };
    initialized = false;
    await Promise.all([
      readAuthorization.reset(ctx.cwd),
      writeAuthorization.reset(ctx.cwd),
    ]);

    if (Boolean(pi.getFlag("no-sandbox"))) {
      state = { mode: "bypass", reason: "disabled by --no-sandbox" };
      setStatus(ctx, state);
      ctx.ui.notify("Sandbox bypassed explicitly by --no-sandbox", "warning");
      return;
    }

    const loaded = loadSandboxConfig(
      ctx.cwd,
      getAgentDir(),
      CONFIG_DIR_NAME,
      ctx.isProjectTrusted(),
    );
    for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");

    if (!loaded.config.enabled) {
      state = { mode: "bypass", reason: "disabled by configuration", loaded };
      setStatus(ctx, state);
      ctx.ui.notify("Sandbox disabled by configuration", "warning");
      return;
    }

    if (!runtime.isSupportedPlatform() || (process.platform !== "darwin" && process.platform !== "linux")) {
      state = {
        mode: "blocked",
        reason: `OS-level sandboxing is not supported by this extension on ${process.platform}`,
        loaded,
      };
      setStatus(ctx, state);
      ctx.ui.notify(state.reason, "error");
      return;
    }

    try {
      await ensureSandboxTempRoot();
      const { enabled: _enabled, ...runtimeConfig } = loaded.config;
      await runtime.initialize(runtimeConfig);
      initialized = true;
      state = { mode: "sandboxed", reason: "active", loaded };
      setStatus(ctx, state);
      ctx.ui.notify("OS-level sandbox initialized", "info");
    } catch (error) {
      await runtime.reset().catch(() => undefined);
      state = {
        mode: "blocked",
        reason: `initialization failed: ${errorMessage(error)}`,
        loaded,
      };
      setStatus(ctx, state);
      ctx.ui.notify(`Sandbox ${state.reason}. Bash is blocked; use --no-sandbox only for an explicit bypass.`, "error");
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    await tracker.stopAll();
    readAuthorization.revoke();
    writeAuthorization.revoke();
    if (initialized) await runtime.reset().catch(() => undefined);
    initialized = false;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (event.reason === "quit") {
      await rm(SANDBOX_TEMP_ROOT, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox state, or use /sandbox allow-read|allow-write|revoke-read|revoke-write|reload",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "reload") {
        await ctx.reload();
        return;
      }
      if (trimmed.toLowerCase().startsWith("allow-read ")) {
        const rawPath = unquote(trimmed.slice("allow-read ".length).trim());
        const paths = await authorizePaths(
          readAuthorization,
          [rawPath],
          "Requested with /sandbox allow-read",
          "read",
          ctx,
        );
        ctx.ui.notify(`Authorized for this session:\n${paths.join("\n")}`, "info");
        return;
      }
      if (trimmed.toLowerCase().startsWith("allow-write ")) {
        const rawPath = unquote(trimmed.slice("allow-write ".length).trim());
        const paths = await authorizePaths(
          writeAuthorization,
          [rawPath],
          "Requested with /sandbox allow-write",
          "write",
          ctx,
        );
        ctx.ui.notify(`Authorized for this session:\n${paths.join("\n")}`, "info");
        return;
      }
      if (trimmed.toLowerCase() === "revoke-read") {
        readAuthorization.revoke();
        ctx.ui.notify("Revoked all external read authorizations.", "info");
        return;
      }
      if (trimmed.toLowerCase() === "revoke-write") {
        writeAuthorization.revoke();
        ctx.ui.notify("Revoked all external write authorizations.", "info");
        return;
      }
      ctx.ui.notify(
        formatState(state, readAuthorization.paths(), writeAuthorization.paths()),
        state.mode === "blocked" ? "error" : "info",
      );
    },
  });
}

function setStatus(ctx: ExtensionContext, state: SandboxState): void {
  if (!ctx.hasUI) return;
  const status = state.mode === "sandboxed"
    ? ctx.ui.theme.fg("success", " sandbox on")
    : state.mode === "blocked"
      ? ctx.ui.theme.fg("error", " sandbox blocked")
      : ctx.ui.theme.fg("warning", " sandbox off");
  ctx.ui.setStatus(STATUS_KEY, status);
}

function formatState(
  state: SandboxState,
  readGrants: string[] = [],
  writeGrants: string[] = [],
): string {
  const lines = [
    `Sandbox: ${state.mode}`,
    `Reason: ${state.reason}`,
  ];
  const loaded = state.loaded;
  if (!loaded) return lines.join("\n");

  const config = loaded.config;
  lines.push(
    `Configuration: ${loaded.loadedFrom.join(", ") || "built-in defaults"}`,
    "",
    "Network:",
    `  Allowed domains: ${config.network.allowedDomains.join(", ") || "(none)"}`,
    `  Denied domains: ${config.network.deniedDomains.join(", ") || "(none)"}`,
    `  Local binding: ${config.network.allowLocalBinding === true ? "allowed" : "blocked"}`,
    "",
    "Filesystem:",
    `  Deny read: ${config.filesystem.denyRead.join(", ") || "(none)"}`,
    `  Baseline allow read: ${config.filesystem.allowRead?.join(", ") || "(none)"}`,
    `  Session read grants: ${readGrants.join(", ") || "(none)"}`,
    `  Baseline allow write: ${config.filesystem.allowWrite.join(", ") || "(none)"}`,
    `  Session write grants: ${writeGrants.join(", ") || "(none)"}`,
    `  Deny write: ${config.filesystem.denyWrite.join(", ") || "(none)"}`,
  );
  if (loaded.warnings.length > 0) {
    lines.push("", "Warnings:", ...loaded.warnings.map((warning) => `  ${warning}`));
  }
  return lines.join("\n");
}

type PathAccess = "read" | "write";

const PATH_ACCESS_META: Record<PathAccess, {
  action: string;
  activity: string;
  tools: string;
  phrase: string;
}> = {
  read: {
    action: "read",
    activity: "reading",
    tools: "bash, read, grep, find, or ls",
    phrase: "Reading",
  },
  write: {
    action: "write to",
    activity: "writing",
    tools: "bash, write, or edit",
    phrase: "Writing",
  },
};

function registerPathAuthorizationTool(
  pi: ExtensionAPI,
  access: PathAccess,
  authorization: SandboxPathAuthorization,
): void {
  const meta = PATH_ACCESS_META[access];
  pi.registerTool({
    name: `sandbox_authorize_${access}`,
    label: `Authorize sandbox ${access}`,
    description: `Request explicit user approval to ${meta.action} files or directories outside the current workspace for this session. Call this before using ${meta.tools} on external paths.`,
    promptSnippet: `Request user authorization before ${meta.activity} paths outside the workspace`,
    promptGuidelines: [
      `Use sandbox_authorize_${access} before any ${meta.tools} operation that needs to ${meta.action} a path outside the current workspace.`,
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 8,
        uniqueItems: true,
      }),
      reason: Type.String({
        description: `Why ${access} access to these external paths is needed`,
        minLength: 1,
        maxLength: 500,
      }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error(`${meta.phrase} authorization cancelled.`);
      const paths = await authorizePaths(
        authorization,
        params.paths,
        params.reason,
        access,
        ctx,
      );
      return {
        content: [{
          type: "text",
          text: `Authorized external ${access} access for this session:\n${paths.join("\n")}`,
        }],
        details: { access, paths, reason: params.reason },
      };
    },
  });
}

async function authorizePaths(
  authorization: SandboxPathAuthorization,
  rawPaths: string[],
  reason: string,
  access: PathAccess,
  ctx: ExtensionContext,
): Promise<string[]> {
  const candidates = await Promise.all(rawPaths.map((path) =>
    authorization.inspect(path, ctx.cwd, { allowMissing: access === "write" })
  ));
  const unique = [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()];
  const newGrants = [];
  for (const candidate of unique) {
    if (!(await authorization.isAllowed(candidate.path, ctx.cwd))) newGrants.push(candidate);
  }

  if (newGrants.length > 0) {
    if (!ctx.hasUI) throw new Error(`External ${access} authorization requires an interactive approval.`);
    const approved = await ctx.ui.confirm(
      `Allow external file ${access} access?`,
      `${reason}\n\n${newGrants.map((grant) => grant.path).join("\n")}\n\nAccess lasts until this session is reloaded or closed.`,
    );
    if (!approved) throw new Error(`External ${access} authorization was not approved.`);
    for (const grant of newGrants) authorization.grant(grant);
  }

  return unique.map((candidate) => candidate.path);
}

function fileAccessPath(
  toolName: string,
  input: Record<string, unknown>,
): { kind: PathAccess; path: string } | undefined {
  if (["read", "grep", "find", "ls"].includes(toolName)) {
    return { kind: "read", path: typeof input.path === "string" ? input.path : "." };
  }
  if (["write", "edit"].includes(toolName) && typeof input.path === "string") {
    return { kind: "write", path: input.path };
  }
  return undefined;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
