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
import {
  loadSandboxConfig,
  type LoadedSandboxConfig,
  type SandboxBackendMode,
} from "./config.ts";
import {
  AppleContainerController,
  createAppleContainerBashOperations,
  type AppleContainerLifecycle,
} from "./apple-container.ts";
import { matchHostExecCommand } from "./host-escape.ts";
import { loadGitIdentity, type GitIdentity } from "./git-identity.ts";
import {
  createSandboxedBashOperations,
  SandboxProcessTracker,
  type SandboxCommandRuntime,
} from "./process.ts";
import {
  authorizePaths,
  fileAccessPath,
  PATH_ACCESS_META,
  registerPathAuthorizationTool,
  type PathAccess,
} from "./path-gate.ts";
import { SandboxPathAuthorization } from "./path-authorization.ts";
import { ensureSandboxTempRoot, SANDBOX_TEMP_ROOT } from "./sandbox-paths.ts";
import {
  formatBytes,
  formatEnvironmentRequests,
  formatEnvironmentStoreStatus,
  formatState,
  setStatus,
  STATUS_KEY,
  type EffectiveSandboxBackend,
  type SandboxState,
} from "./status.ts";
import { errorMessage, unquote } from "./util.ts";
import { installTrustedRuntime } from "./environments/artifact-catalog.ts";
import { resolveLocalEnvironments } from "./environments/local-resolver.ts";
import { resolveManagedEnvironmentPlan } from "./environments/managed-resolver.ts";
import { createRestrictedArchiveExtractor } from "./environments/restricted-installer.ts";
import { SandboxEnvironmentSessionController } from "./environments/session-controller.ts";
import { resolveEnvironmentSelection } from "./environments/selection.ts";
import { selectDevelopmentEnvironments } from "./environments/selector.ts";
import { EnvironmentStore } from "./environments/store.ts";
import type { EnvironmentPlan, RequestedEnvironment } from "./environments/types.ts";
import {
  formatKubernetesGrants,
  SandboxKubernetesController,
} from "./kubernetes/controller.ts";
import { discoverKubernetesContexts } from "./kubernetes/context-source.ts";
import { KubernetesContextSelectionStore } from "./kubernetes/context-selection-store.ts";
import { KubernetesSessionAccess } from "./kubernetes/session-access.ts";

export { resolveAppleContainerHostGateway } from "./kubernetes/apple-bridge.ts";

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
  /** Test seam for Apple Container prerequisite and lifecycle behavior. */
  appleContainerController?: AppleContainerLifecycle;
  /** Test seam for local development-environment discovery. */
  environmentResolver?: typeof resolveLocalEnvironments;
  /** Test seams for managed environment resolution and storage. */
  managedEnvironmentResolver?: typeof resolveManagedEnvironmentPlan;
  environmentStore?: EnvironmentStore;
  environmentSelector?: typeof selectDevelopmentEnvironments;
  runtimeInstaller?: typeof installTrustedRuntime;
  projectStateRoot?: string;
  /** Test seams for session-scoped Kubernetes access. */
  kubernetesContextDiscovery?: typeof discoverKubernetesContexts;
  kubernetesAccessFactory?: () => Promise<KubernetesSessionAccess>;
  kubernetesSelectionStore?: KubernetesContextSelectionStore;
}

export function resolveSandboxBackendMode(
  flagValue: boolean | string | undefined,
  configured: unknown,
): SandboxBackendMode {
  const hasFlag = flagValue !== undefined && flagValue !== false && flagValue !== "";
  const candidate = hasFlag ? flagValue : configured;
  if (candidate === "auto" || candidate === "process" || candidate === "apple-container") {
    return candidate;
  }
  const source = hasFlag ? "--sandbox-mode" : "isolation.mode";
  throw new Error(
    `Invalid ${source} ${JSON.stringify(candidate)}; expected auto, process, or apple-container`,
  );
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
  const appleContainer = authorizationOptions.appleContainerController ?? new AppleContainerController();
  const environmentStore = authorizationOptions.environmentStore
    ?? new EnvironmentStore(join(getAgentDir(), "cache", "sandbox"));
  const projectStateRoot = authorizationOptions.projectStateRoot
    ?? join(getAgentDir(), "cache", "sandbox", "projects");
  const kubernetesSelectionStore = authorizationOptions.kubernetesSelectionStore
    ?? new KubernetesContextSelectionStore(join(getAgentDir(), "cache", "sandbox", "kubernetes-selections"));
  const environmentController = new SandboxEnvironmentSessionController({
    store: environmentStore,
    projectStateRoot,
    localResolver: authorizationOptions.environmentResolver,
    managedResolver: authorizationOptions.managedEnvironmentResolver,
    installer: authorizationOptions.runtimeInstaller,
  });
  const piReadRoots = authorizationOptions.piReadRoots ?? defaultPiReadRoots();
  const authOptions = { ...authorizationOptions, piReadRoots };
  const readAuthorization = new SandboxPathAuthorization(authOptions);
  const writeAuthorization = new SandboxPathAuthorization(authOptions);
  const baseBash = createBashToolDefinition(process.cwd());
  let initialized = false;
  let gitIdentity: GitIdentity | undefined;
  let activeEnvironmentPlan: EnvironmentPlan | undefined;
  let state: SandboxState = { mode: "starting", reason: "waiting for session start" };
  // Session-level approval memory. Host execution is keyed by command word;
  // network access is keyed by exact hostname (and applies to every port).
  const approvedHostExecWords = new Set<string>();
  const approvedNetworkDomains = new Set<string>();
  const pendingNetworkApprovals = new Map<string, Promise<boolean>>();
  const kubernetesController = new SandboxKubernetesController({
    state: () => state.mode === "sandboxed"
      ? {
          active: true,
          effectiveBackend: state.effectiveBackend,
          config: state.loaded.config.kubernetes,
        }
      : { active: false, config: state.loaded?.config.kubernetes },
    environmentPlan: () => activeEnvironmentPlan,
    environmentResolver: authorizationOptions.environmentResolver,
    contextDiscovery: authorizationOptions.kubernetesContextDiscovery,
    accessFactory: authorizationOptions.kubernetesAccessFactory,
    appleContainerBinary: () => state.loaded?.config.isolation.appleContainer.binary,
    selectionStore: kubernetesSelectionStore,
  });
  const processOperations = createSandboxedBashOperations(runtime, tracker, () => {
    const filesystem = state.loaded?.config.filesystem;
    if (!filesystem) return undefined;
    return {
      filesystem: {
        ...filesystem,
        allowRead: [
          ...(filesystem.allowRead ?? []),
          ...(activeEnvironmentPlan?.allowRead ?? []),
          ...readAuthorization.paths(),
        ],
        allowWrite: [
          ...filesystem.allowWrite,
          ...writeAuthorization.paths(),
        ],
        denyWrite: [
          ...filesystem.denyWrite,
          ...(kubernetesController.kubeconfigPath ? [kubernetesController.kubeconfigPath] : []),
        ],
      },
    };
  }, () => gitIdentity, () => activeEnvironmentPlan?.env);

  const commandOperations = (ctx: ExtensionContext) => {
    if (state.mode !== "sandboxed" || state.effectiveBackend !== "apple-container") {
      return processOperations;
    }
    const config = state.loaded.config;
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
      environment: () => activeEnvironmentPlan,
    });
  };

  pi.registerFlag("no-sandbox", {
    description: "Explicitly run local bash commands without OS-level sandboxing",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("sandbox-mode", {
    description: "Sandbox backend: auto, process, or apple-container",
    type: "string",
  });

  pi.registerFlag("sandbox-env", {
    description: "Comma-separated development environments, for example go@1.24.2,python,node,pnpm,kubectl",
    type: "string",
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

  pi.on("session_start", async (event, ctx) => {
    state = { mode: "starting", reason: "initializing" };
    await environmentController.reset();
    initialized = false;
    await kubernetesController.stop();
    activeEnvironmentPlan = undefined;
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
    await kubernetesController.initializeSession(ctx, loaded.config.kubernetes);

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

    let requestedBackend: SandboxBackendMode | undefined;
    try {
      requestedBackend = resolveSandboxBackendMode(
        pi.getFlag("sandbox-mode"),
        loaded.config.isolation.mode,
      );
      let environmentFlag = pi.getFlag("sandbox-env");
      const hasEnvironmentFlag = typeof environmentFlag === "string"
        && environmentFlag.trim() !== "";
      if (
        !hasEnvironmentFlag
        && loaded.config.developmentEnvironments.promptOnStart
        && event.reason === "startup"
        && ctx.mode === "tui"
      ) {
        environmentFlag = await (authorizationOptions.environmentSelector
          ?? selectDevelopmentEnvironments)(ctx, loaded.config.developmentEnvironments);
      }
      const requestedEnvironments = resolveEnvironmentSelection(
        environmentFlag,
        loaded.config.developmentEnvironments,
      );
      await ensureSandboxTempRoot();
      const {
        enabled: _enabled,
        isolation: _isolation,
        hostExec: _hostExec,
        developmentEnvironments: _developmentEnvironments,
        kubernetes: _kubernetes,
        ...runtimeConfig
      } = loaded.config;
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
      const installerOptions = {
        archiveExtractor: createRestrictedArchiveExtractor(runtime),
      };
      const approveManagedInstall = async (missing: RequestedEnvironment[]): Promise<boolean> => {
        if (!ctx.hasUI) {
          throw new Error(`Managed runtime installation requires interactive approval: ${formatEnvironmentRequests(missing)}`);
        }
        return ctx.ui.confirm(
          "Install managed runtimes?",
          `${formatEnvironmentRequests(missing)} are not installed. Download checksum-verified official artifacts into the shared environment store?`,
        );
      };
      const resolutionContext = {
        cwd: ctx.cwd,
        env: process.env,
        config: loaded.config.developmentEnvironments,
        installerOptions,
        approveInstall: approveManagedInstall,
      };
      const resolveProcessEnvironmentPlan = () => environmentController.resolveProcess(
        requestedEnvironments,
        resolutionContext,
      );
      const resolveAppleEnvironmentPlan = () => environmentController.resolveApple(
        requestedEnvironments,
        resolutionContext,
      );

      // Apple managed runtimes require exact versions (the Linux guest cannot
      // reuse a host-local interpreter). In auto mode the outcome is resolved
      // explicitly so a version-less selection resolves locally via Process
      // without surfacing a misleading VM fallback warning.
      type AutoAppleOutcome =
        | { kind: "resolved"; plan?: EnvironmentPlan }
        | { kind: "failed"; reason: string }
        | { kind: "skipped" };

      const unpinnedEnvironmentIds = requestedEnvironments
        .filter((request) => request.requestedVersion === undefined)
        .map((request) => request.id);

      let processEnvironmentPlan: EnvironmentPlan | undefined;
      let appleEnvironmentPlan: EnvironmentPlan | undefined;
      let autoAppleOutcome: AutoAppleOutcome = { kind: "skipped" };
      if (requestedBackend === "process") {
        processEnvironmentPlan = await resolveProcessEnvironmentPlan();
      } else if (requestedBackend === "apple-container") {
        appleEnvironmentPlan = await resolveAppleEnvironmentPlan();
      } else if (requestedEnvironments.length === 0) {
        autoAppleOutcome = { kind: "resolved" };
      } else if (unpinnedEnvironmentIds.length === 0) {
        try {
          autoAppleOutcome = { kind: "resolved", plan: await resolveAppleEnvironmentPlan() };
        } catch (error) {
          autoAppleOutcome = { kind: "failed", reason: errorMessage(error) };
        }
      }

      let effectiveBackend: EffectiveSandboxBackend = "process";
      let fallbackReason: string | undefined;
      if (requestedBackend === "process") {
        activeEnvironmentPlan = processEnvironmentPlan;
      } else if (requestedBackend === "apple-container") {
        await appleContainer.preflight(loaded.config.isolation.appleContainer, ctx.cwd);
        effectiveBackend = "apple-container";
        activeEnvironmentPlan = appleEnvironmentPlan;
      } else if (autoAppleOutcome.kind === "failed") {
        fallbackReason = `managed Apple environment unavailable: ${autoAppleOutcome.reason}`;
        processEnvironmentPlan = await resolveProcessEnvironmentPlan();
        activeEnvironmentPlan = processEnvironmentPlan;
        ctx.ui.notify(
          `${fallbackReason}. Falling back to the Process sandbox.`,
          "warning",
        );
      } else if (autoAppleOutcome.kind === "resolved") {
        try {
          await appleContainer.preflight(loaded.config.isolation.appleContainer, ctx.cwd);
          effectiveBackend = "apple-container";
          activeEnvironmentPlan = autoAppleOutcome.plan;
        } catch (error) {
          fallbackReason = errorMessage(error);
          processEnvironmentPlan = await resolveProcessEnvironmentPlan();
          activeEnvironmentPlan = processEnvironmentPlan;
          ctx.ui.notify(
            `Apple Container prerequisites are not satisfied (${fallbackReason}). Falling back to the Process sandbox. Use --sandbox-mode apple-container to require VM isolation.`,
            "warning",
          );
        }
      } else {
        processEnvironmentPlan = await resolveProcessEnvironmentPlan();
        activeEnvironmentPlan = processEnvironmentPlan;
        ctx.ui.notify(
          `Using the Process sandbox instead of Apple Container because ${unpinnedEnvironmentIds.join(", ")} has no pinned version. Pin versions (--sandbox-env ${unpinnedEnvironmentIds.map((id) => `${id}@<version>`).join(",")}) to prefer Apple Container.`,
          "info",
        );
      }

      await environmentController.activate(
        activeEnvironmentPlan,
        ctx.sessionManager.getSessionId(),
        loaded.config.developmentEnvironments,
      );

      state = {
        mode: "sandboxed",
        reason: fallbackReason ? `active; automatic Process fallback: ${fallbackReason}` : "active",
        loaded,
        requestedBackend,
        effectiveBackend,
        environmentPlan: activeEnvironmentPlan,
      };
      setStatus(ctx, state);
      ctx.ui.notify(
        effectiveBackend === "apple-container"
          ? "Apple Container + Process sandbox initialized"
          : "Process sandbox initialized",
        "info",
      );
      if (
        loaded.config.kubernetes.promptOnStart
        && event.reason === "startup"
        && ctx.mode === "tui"
      ) {
        try {
          await kubernetesController.promptOnStart(ctx);
        } catch (error) {
          ctx.ui.notify(`Kubernetes context was not authorized: ${errorMessage(error)}`, "warning");
        }
      }
    } catch (error) {
      await environmentController.reset();
      await runtime.reset().catch(() => undefined);
      initialized = false;
      state = {
        mode: "blocked",
        reason: `initialization failed: ${errorMessage(error)}`,
        loaded,
        requestedBackend,
      };
      setStatus(ctx, state);
      const reason = state.reason.replace(/[.\s]+$/, "");
      ctx.ui.notify(`Sandbox ${reason}. Bash is blocked; use --no-sandbox only for an explicit bypass.`, "error");
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    await kubernetesController.stop();
    await environmentController.reset();
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
    description: "Show sandbox state, or manage path, network, and Kubernetes session grants",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "reload") {
        await ctx.reload();
        return;
      }
      if (trimmed.toLowerCase() === "env status" || trimmed.toLowerCase() === "env list") {
        const storeStatus = await environmentController.status();
        ctx.ui.notify(formatEnvironmentStoreStatus(
          storeStatus,
          trimmed.toLowerCase() === "env list",
        ), "info");
        return;
      }
      if (trimmed.toLowerCase() === "env prune" || trimmed.toLowerCase() === "env prune --all") {
        const config = state.loaded?.config.developmentEnvironments.install;
        if (!config) throw new Error("Environment pruning requires loaded sandbox configuration");
        const removeAll = trimmed.toLowerCase().endsWith("--all");
        const result = await environmentController.prune(config, removeAll);
        ctx.ui.notify(
          `Environment store pruned ${result.removedDigests.length} inactive object(s); ${formatBytes(result.bytesAfter)} remain.`,
          "info",
        );
        return;
      }
      if (trimmed.toLowerCase() === "kube") {
        ctx.ui.notify(formatKubernetesGrants(kubernetesController.list()), "info");
        return;
      }
      if (trimmed.toLowerCase() === "kube forget") {
        await kubernetesController.forget(ctx);
        ctx.ui.notify("Forgot persisted Kubernetes context selections for this project.", "info");
        return;
      }
      if (trimmed.toLowerCase() === "kube revoke-all") {
        await kubernetesController.revokeAll();
        ctx.ui.notify("Revoked all Kubernetes context grants for this session.", "info");
        return;
      }
      if (trimmed.toLowerCase().startsWith("kube revoke ")) {
        const contextName = unquote(trimmed.slice("kube revoke ".length).trim());
        await kubernetesController.revoke(contextName);
        ctx.ui.notify(`Revoked Kubernetes context grant: ${contextName}`, "info");
        return;
      }
      if (trimmed.toLowerCase() === "kube select" || trimmed.toLowerCase().startsWith("kube select ")) {
        await kubernetesController.grant(trimmed.slice("kube select".length).trim(), ctx);
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
