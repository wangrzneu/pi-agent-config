import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  CONFIG_DIR_NAME,
  createBashToolDefinition,
  createLocalBashOperations,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadSandboxConfig, type LoadedSandboxConfig } from "./config.ts";
import {
  AppleContainerController,
  createAppleContainerBashOperations,
} from "./apple-container.ts";
import { matchHostExecCommand } from "./host-escape.ts";
import { loadGitIdentity, type GitIdentity } from "./git-identity.ts";
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
  initialize(config: SandboxRuntimeConfig, ask?: SandboxAskCallback): Promise<void>;
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

export function defaultPiReadRoots(homeDir: string = homedir()): string[] {
  const agentDir = getAgentDir();
  const roots = [
    "skills",
    "prompts",
    "themes",
    "extensions",
    "git",
    "packages",
  ].map((name) => join(agentDir, name));
  // Pi loads global user skills from ~/.agents/skills (docs/sdk.md). They are
  // runtime guidance like agentDir/skills, not user credentials, so they are
  // readable by default too. Guarded by existsSync because the directory often
  // does not exist and an empty root is noise.
  const userAgentsSkills = join(homeDir, ".agents", "skills");
  if (existsSync(userAgentsSkills)) roots.push(userAgentsSkills);
  return roots;
}

export function registerSandboxExtension(
  pi: ExtensionAPI,
  runtime: SandboxRuntime,
  authorizationOptions: AuthorizationOptions = {},
): void {
  const tracker = new SandboxProcessTracker();
  const appleContainer = new AppleContainerController();
  const piReadRoots = authorizationOptions.piReadRoots ?? defaultPiReadRoots();
  const authOptions = { ...authorizationOptions, piReadRoots };
  const readAuthorization = new SandboxPathAuthorization(authOptions);
  const writeAuthorization = new SandboxPathAuthorization(authOptions);
  const baseBash = createBashToolDefinition(process.cwd());
  let initialized = false;
  let gitIdentity: GitIdentity | undefined;
  let state: SandboxState = { mode: "starting", reason: "waiting for session start" };
  // Session-level approval memory. Host execution is keyed by command word;
  // network access is keyed by exact hostname (and applies to every port).
  const approvedHostExecWords = new Set<string>();
  const approvedNetworkDomains = new Set<string>();
  const pendingNetworkApprovals = new Map<string, Promise<boolean>>();
  const processOperations = createSandboxedBashOperations(runtime, tracker, () => {
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
  }, () => gitIdentity);

  const commandOperations = (ctx: ExtensionContext) => {
    const config = state.loaded?.config;
    if (!config?.isolation.appleContainer.enabled) return processOperations;
    return createAppleContainerBashOperations(appleContainer, {
      tracker,
      container: config.isolation.appleContainer,
      policy: () => ({
        config,
        readGrants: readAuthorization.paths(),
        writeGrants: writeAuthorization.paths(),
      }),
      gitIdentity: () => gitIdentity,
      authorizeNetwork: (host, port) => authorizeNetworkDomain(
        host,
        port,
        approvedNetworkDomains,
        pendingNetworkApprovals,
        ctx,
      ),
    });
  };

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

      const command = String(params.command ?? "");
      // Commands that need host credentials/network (remote git push/pull,
      // gh, and configurable tools like aws/gcloud/docker whose credentials
      // live in ~-homed files the sandbox denies) run on the host after
      // approval. The approval is remembered per command word for the session.
      const hostPrefixes = state.loaded?.config.hostExec?.commands ?? [];
      const hostMatch = state.mode === "sandboxed"
        ? matchHostExecCommand(command, hostPrefixes)
        : undefined;
      if (hostMatch !== undefined) {
        const { word } = hostMatch;
        const preApproved = approvedHostExecWords.has(word);
        if (!preApproved && (!ctx.hasUI || ctx.mode !== "tui")) {
          throw new Error(
            `${word} operations require interactive approval; run it in your own terminal or approve in the Pi TUI.`,
          );
        }
        const approved = preApproved || await ctx.ui.confirm(
          "Run this operation on the host?",
          `${word} needs host credentials and direct network that the sandbox denies. Run it on the host (approved once per session)?\n\n` + command,
        );
        if (!approved) throw new Error("Operation was not approved.");
        approvedHostExecWords.add(word);
        const hostTool = createBashToolDefinition(ctx.cwd, { operations: createLocalBashOperations() });
        return hostTool.execute(id, params, signal, onUpdate, ctx);
      }

      const tool = state.mode === "sandboxed"
        ? createBashToolDefinition(ctx.cwd, { operations: commandOperations(ctx) })
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

  pi.on("user_bash", (_event, ctx) => {
    if (state.mode === "sandboxed") return { operations: commandOperations(ctx) };
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
    approvedNetworkDomains.clear();
    pendingNetworkApprovals.clear();
    // Read the host git identity so sandboxed git commits inherit the user's
    // ~/.gitconfig identity (home reads are denied inside the sandbox).
    gitIdentity = loadGitIdentity();
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
      await runtime.initialize(
        runtimeConfig,
        ({ host, port }) => authorizeNetworkDomain(
          host,
          port,
          approvedNetworkDomains,
          pendingNetworkApprovals,
          ctx,
        ),
      );
      initialized = true;
      if (loaded.config.isolation.appleContainer.enabled) {
        await appleContainer.preflight(loaded.config.isolation.appleContainer);
      }
      state = { mode: "sandboxed", reason: "active", loaded };
      setStatus(ctx, state);
      ctx.ui.notify(
        loaded.config.isolation.appleContainer.enabled
          ? "Apple Container + Process sandbox initialized"
          : "OS-level sandbox initialized",
        "info",
      );
    } catch (error) {
      await runtime.reset().catch(() => undefined);
      initialized = false;
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
    const containerBinary = state.loaded?.config.isolation.appleContainer.binary;
    if (containerBinary) await appleContainer.stopAll(containerBinary);
    await tracker.stopAll();
    readAuthorization.revoke();
    writeAuthorization.revoke();
    approvedNetworkDomains.clear();
    pendingNetworkApprovals.clear();
    if (initialized) await runtime.reset().catch(() => undefined);
    initialized = false;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (event.reason === "quit") {
      await rm(SANDBOX_TEMP_ROOT, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox state, or use /sandbox allow-read|allow-write|revoke-read|revoke-write|revoke-network|reload",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "reload") {
        await ctx.reload();
        return;
      }
      const ALLOW_PREFIXES: Record<string, PathAccess> = { "allow-read": "read", "allow-write": "write" };
      for (const [prefix, access] of Object.entries(ALLOW_PREFIXES)) {
        if (trimmed.toLowerCase().startsWith(`${prefix} `)) {
          const rawPath = unquote(trimmed.slice(prefix.length + 1).trim());
          const auth = access === "read" ? readAuthorization : writeAuthorization;
          const paths = await authorizePaths(
            auth,
            [rawPath],
            `Requested with /sandbox ${prefix}`,
            access,
            ctx,
          );
          ctx.ui.notify(`Authorized for this session:\n${paths.join("\n")}`, "info");
          return;
        }
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
      if (trimmed.toLowerCase() === "revoke-network") {
        approvedNetworkDomains.clear();
        ctx.ui.notify("Revoked all session network authorizations.", "info");
        return;
      }
      ctx.ui.notify(
        formatState(
          state,
          readAuthorization.paths(),
          writeAuthorization.paths(),
          approvedHostExecWords,
          approvedNetworkDomains,
        ),
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
  approvedHostExecWords: ReadonlySet<string> = new Set(),
  approvedNetworkDomains: ReadonlySet<string> = new Set(),
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
    "Isolation:",
    `  Host launcher: ${config.isolation.appleContainer.enabled ? "trusted fixed argv (Apple XPC is incompatible with Seatbelt)" : "ASRT (Seatbelt/bubblewrap)"}`,
    `  Apple Container VM: ${config.isolation.appleContainer.enabled ? "enabled" : "disabled"}`,
    `  Guest process: ${config.isolation.appleContainer.enabled ? "ASRT (bubblewrap + proxy; VM isolates host IPC)" : "not applicable"}`,
    `  Workspace: ${config.isolation.appleContainer.enabled ? config.isolation.appleContainer.workspaceMode : "direct"}`,
    `  Policy parity: ${config.isolation.appleContainer.enabled ? "strict (transactional workspace)" : "process backend"}`,
    "",
    "Network:",
    `  Allowed domains: ${config.network.allowedDomains.join(", ") || "(none)"}`,
    `  Denied domains: ${config.network.deniedDomains.join(", ") || "(none)"}`,
    `  Prompt for unlisted domains: ${config.network.strictAllowlist === true ? "disabled" : "enabled"}`,
    `  Session domain grants: ${[...approvedNetworkDomains].join(", ") || "(none)"}`,
    `  Local binding: ${config.network.allowLocalBinding === true ? "allowed" : "blocked"}`,
    "",
    "Filesystem:",
    `  Deny read: ${config.filesystem.denyRead.join(", ") || "(none)"}`,
    `  Baseline allow read: ${config.filesystem.allowRead?.join(", ") || "(none)"}`,
    `  Session read grants: ${readGrants.join(", ") || "(none)"}`,
    `  Baseline allow write: ${config.filesystem.allowWrite.join(", ") || "(none)"}`,
    `  Session write grants: ${writeGrants.join(", ") || "(none)"}`,
    `  Deny write: ${config.filesystem.denyWrite.join(", ") || "(none)"}`,
    "",
    "Host execution (after approval):",
    `  Extra command prefixes: ${config.hostExec?.commands?.join(", ") || "(none)"}`,
    `  Approved this session: ${[...approvedHostExecWords].join(", ") || "(none)"}`,
  );
  if (loaded.warnings.length > 0) {
    lines.push("", "Warnings:", ...loaded.warnings.map((warning) => `  ${warning}`));
  }
  return lines.join("\n");
}

async function authorizeNetworkDomain(
  rawHost: string,
  port: number | undefined,
  approvedDomains: Set<string>,
  pendingApprovals: Map<string, Promise<boolean>>,
  ctx: ExtensionContext,
): Promise<boolean> {
  const host = normalizeNetworkHost(rawHost);
  if (approvedDomains.has(host)) return true;

  const pending = pendingApprovals.get(host);
  if (pending) return pending;
  if (!ctx.hasUI) return false;

  const approval = ctx.ui.confirm(
    "Allow sandbox network access?",
    `A sandboxed command attempted to connect to a domain that is not in network.allowedDomains.\n\n${host}${port === undefined ? "" : `:${port}`}\n\nAllow this exact domain on any port for the rest of this session?`,
  ).then((approved) => {
    if (approved) approvedDomains.add(host);
    return approved;
  }).finally(() => pendingApprovals.delete(host));
  pendingApprovals.set(host, approval);
  return approval;
}

function normalizeNetworkHost(host: string): string {
  const normalized = host.toLowerCase();
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
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
