import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
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
import { SandboxPathAuthorization } from "./path-authorization.ts";
import { ensureSandboxTempRoot, SANDBOX_TEMP_ROOT } from "./sandbox-paths.ts";
import { errorMessage } from "./util.ts";
import { installTrustedRuntime } from "./environments/artifact-catalog.ts";
import { resolveLocalEnvironments } from "./environments/local-resolver.ts";
import { resolveManagedEnvironmentPlan } from "./environments/managed-resolver.ts";
import { createRestrictedArchiveExtractor } from "./environments/restricted-installer.ts";
import {
  provisionManagedObjects,
  resolveProcessEnvironmentPlan as resolveProcessPlan,
} from "./environments/process-resolver.ts";
import { resolveEnvironmentSelection } from "./environments/selection.ts";
import { selectDevelopmentEnvironments } from "./environments/selector.ts";
import { EnvironmentStore, parseEnvironmentStoreSize } from "./environments/store.ts";
import type { EnvironmentPlan, RequestedEnvironment } from "./environments/types.ts";
import { KubernetesCapabilityGateway } from "./kubernetes/capability-gateway.ts";
import { discoverKubernetesContexts } from "./kubernetes/context-source.ts";
import { KubectlProxyBroker } from "./kubernetes/proxy-broker.ts";
import {
  KubernetesSessionAccess,
  type KubernetesSessionGrantSummary,
} from "./kubernetes/session-access.ts";
import { createKubernetesGatewayTlsMaterial } from "./kubernetes/tls-material.ts";

const STATUS_KEY = "sandbox";
const APPLE_KUBERNETES_DIRECTORY = "/opt/pi-kube";
const APPLE_KUBECONFIG_PATH = `${APPLE_KUBERNETES_DIRECTORY}/config.json`;

type EffectiveSandboxBackend = Exclude<SandboxBackendMode, "auto">;

type SandboxState =
  | {
      mode: "starting" | "bypass" | "blocked";
      reason: string;
      loaded?: LoadedSandboxConfig;
      requestedBackend?: SandboxBackendMode;
      effectiveBackend?: never;
      environmentPlan?: EnvironmentPlan;
    }
  | {
      mode: "sandboxed";
      reason: string;
      loaded: LoadedSandboxConfig;
      requestedBackend: SandboxBackendMode;
      effectiveBackend: EffectiveSandboxBackend;
      environmentPlan?: EnvironmentPlan;
    };

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
  /** Test seams for session-scoped Kubernetes access. */
  kubernetesContextDiscovery?: typeof discoverKubernetesContexts;
  kubernetesAccessFactory?: () => Promise<KubernetesSessionAccess>;
}

export function resolveAppleContainerHostGateway(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
  const entries = Object.entries(interfaces);
  const bridgeEntries = entries.some(([name]) => name === "bridge100")
    ? entries.filter(([name]) => name === "bridge100")
    : entries.filter(([name]) => /^bridge\d+$/.test(name));
  const candidates = bridgeEntries
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address)
    .filter((address) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address));
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) {
    throw new Error(
      `Unable to identify a unique private Apple Container host gateway (${unique.join(", ") || "none"})`,
    );
  }
  return unique[0];
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
  const piReadRoots = authorizationOptions.piReadRoots ?? defaultPiReadRoots();
  const authOptions = { ...authorizationOptions, piReadRoots };
  const readAuthorization = new SandboxPathAuthorization(authOptions);
  const writeAuthorization = new SandboxPathAuthorization(authOptions);
  const baseBash = createBashToolDefinition(process.cwd());
  let initialized = false;
  let gitIdentity: GitIdentity | undefined;
  let activeEnvironmentPlan: EnvironmentPlan | undefined;
  let kubernetesAccess: KubernetesSessionAccess | undefined;
  let environmentLeaseId: string | undefined;
  let state: SandboxState = { mode: "starting", reason: "waiting for session start" };
  // Session-level approval memory. Host execution is keyed by command word;
  // network access is keyed by exact hostname (and applies to every port).
  const approvedHostExecWords = new Set<string>();
  const approvedKubernetesExecInvocations = new Set<string>();
  const rememberedKubernetesContexts = new Set<string>();
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
          ...(activeEnvironmentPlan?.allowRead ?? []),
          ...readAuthorization.paths(),
        ],
        allowWrite: [
          ...filesystem.allowWrite,
          ...writeAuthorization.paths(),
        ],
        denyWrite: [
          ...filesystem.denyWrite,
          ...(kubernetesAccess ? [kubernetesAccess.kubeconfigPath] : []),
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

  const hostKubectlExecutable = async (ctx: ExtensionContext): Promise<string> => {
    if (state.mode !== "sandboxed") throw new Error("Kubernetes access requires an active sandbox");
    if (state.effectiveBackend !== "apple-container") {
      const executable = environmentExecutable(activeEnvironmentPlan, "kubectl");
      if (!executable) throw new Error("Select the kubectl development environment before granting Kubernetes contexts");
      return executable;
    }
    const resolver = authorizationOptions.environmentResolver ?? resolveLocalEnvironments;
    const [hostProfile] = await resolver([{ id: "kubectl" }], { cwd: ctx.cwd, env: process.env });
    const executable = hostProfile?.binDirectories[0]
      ? join(hostProfile.binDirectories[0], "kubectl")
      : undefined;
    if (!executable) {
      throw new Error("Apple Container Kubernetes access requires a trusted host kubectl for the credential broker");
    }
    return executable;
  };

  const ensureKubernetesAccess = async (ctx: ExtensionContext): Promise<KubernetesSessionAccess> => {
    if (kubernetesAccess) return kubernetesAccess;
    if (state.mode !== "sandboxed") throw new Error("Kubernetes access requires an active sandbox");
    const kubectl = await hostKubectlExecutable(ctx);
    if (!kubectl) {
      throw new Error("Select the kubectl development environment before granting Kubernetes contexts");
    }
    if (authorizationOptions.kubernetesAccessFactory) {
      kubernetesAccess = await authorizationOptions.kubernetesAccessFactory();
      return kubernetesAccess;
    }
    const gatewayHost = state.effectiveBackend === "apple-container"
      ? resolveAppleContainerHostGateway()
      : "127.0.0.1";
    const tls = await createKubernetesGatewayTlsMaterial(
      join(SANDBOX_TEMP_ROOT, "kubernetes", "tls"),
      [gatewayHost],
    );
    const gateway = new KubernetesCapabilityGateway({
      tls: { key: tls.key, cert: tls.cert },
      listenHost: gatewayHost,
      advertiseHost: gatewayHost,
    });
    await gateway.start();
    kubernetesAccess = new KubernetesSessionAccess({
      broker: new KubectlProxyBroker(),
      gateway,
      kubeconfigPath: join(SANDBOX_TEMP_ROOT, "kubernetes", "config.json"),
      gatewayCaData: tls.caData,
    });
    return kubernetesAccess;
  };

  const grantKubernetesContext = async (
    requestedContextName: string | undefined,
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    if (state.mode !== "sandboxed") throw new Error("Kubernetes access requires an active sandbox");
    const kubectl = await hostKubectlExecutable(ctx);
    if (!kubectl) throw new Error("Select the kubectl development environment first");
    const discovered = await (authorizationOptions.kubernetesContextDiscovery
      ?? discoverKubernetesContexts)({ kubectl, env: process.env });
    let contextName = requestedContextName ? unquote(requestedContextName) : "";
    if (!contextName) {
      if (!ctx.hasUI) throw new Error("Kubernetes context selection requires an interactive UI");
      const selected = await ctx.ui.select(
        "Select a Kubernetes context for this sandbox session",
        discovered.contexts.map((context) => context.name),
      );
      if (!selected) return false;
      contextName = selected;
    }
    const metadata = discovered.contexts.find((context) => context.name === contextName);
    if (!metadata) throw new Error(`Unknown local Kubernetes context: ${contextName}`);
    if (metadata.execCommand) {
      const approvalKey = JSON.stringify([
        contextName,
        metadata.execCommand,
        metadata.execArgs ?? [],
        metadata.execEnvironmentNames ?? [],
      ]);
      if (!approvedKubernetesExecInvocations.has(approvalKey)) {
        if (!ctx.hasUI) throw new Error("Kubernetes credential helper approval requires an interactive UI");
        const approved = await ctx.ui.confirm(
          "Run Kubernetes credential helper on the host?",
          `Context ${contextName} authenticates with:\n${formatKubernetesExecInvocation(metadata)}\nAllow this exact host credential-helper invocation for this session?`,
        );
        if (!approved) throw new Error("Kubernetes credential helper was not approved");
        approvedKubernetesExecInvocations.add(approvalKey);
      }
    }
    const access = await ensureKubernetesAccess(ctx);
    const config = state.loaded.config.kubernetes;
    await access.grant({
      metadata,
      kubectl,
      env: process.env,
      access: config.defaultAccess,
      namespaces: config.defaultNamespaces === "all"
        ? undefined
        : [metadata.namespace ?? "default"],
    });
    if (activeEnvironmentPlan) {
      if (state.effectiveBackend === "apple-container") {
        activeEnvironmentPlan.env.KUBECONFIG = APPLE_KUBECONFIG_PATH;
        activeEnvironmentPlan.mounts = [
          ...(activeEnvironmentPlan.mounts ?? []).filter((mount) => mount.target !== APPLE_KUBERNETES_DIRECTORY),
          { source: join(access.kubeconfigPath, ".."), target: APPLE_KUBERNETES_DIRECTORY, readonly: true },
        ];
        if (!activeEnvironmentPlan.allowRead.includes(APPLE_KUBECONFIG_PATH)) {
          activeEnvironmentPlan.allowRead.push(APPLE_KUBECONFIG_PATH);
        }
      } else {
        activeEnvironmentPlan.env.KUBECONFIG = access.kubeconfigPath;
      }
    }
    if (config.persistContextSelection) rememberedKubernetesContexts.add(contextName);
    ctx.ui.notify(
      `Authorized Kubernetes context for this session: ${contextName}\nAccess: ${config.defaultAccess}\nNamespaces: ${config.defaultNamespaces === "all" ? "all" : metadata.namespace ?? "default"}`,
      "info",
    );
    return true;
  };

  const clearKubernetesEnvironment = (): void => {
    if (!activeEnvironmentPlan) return;
    activeEnvironmentPlan.env.KUBECONFIG = undefined;
    activeEnvironmentPlan.mounts = activeEnvironmentPlan.mounts
      ?.filter((mount) => mount.target !== APPLE_KUBERNETES_DIRECTORY);
    activeEnvironmentPlan.allowRead = activeEnvironmentPlan.allowRead
      .filter((path) => path !== APPLE_KUBECONFIG_PATH);
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
    if (environmentLeaseId) await environmentStore.releaseLease(environmentLeaseId).catch(() => undefined);
    environmentLeaseId = undefined;
    initialized = false;
    activeEnvironmentPlan = undefined;
    kubernetesAccess = undefined;
    approvedKubernetesExecInvocations.clear();
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
      const resolveProcessEnvironmentPlan = async (): Promise<EnvironmentPlan | undefined> => {
        if (requestedEnvironments.length === 0) return undefined;
        return resolveProcessPlan(requestedEnvironments, {
          cwd: ctx.cwd,
          env: process.env,
          platform: `${process.platform}-${process.arch}`,
          store: environmentStore,
          config: loaded.config.developmentEnvironments,
          localResolver: authorizationOptions.environmentResolver,
          installer: authorizationOptions.runtimeInstaller,
          installerOptions,
          approveInstall: approveManagedInstall,
        });
      };
      const resolveAppleEnvironmentPlan = async (): Promise<EnvironmentPlan | undefined> => {
        if (requestedEnvironments.length === 0) return undefined;
        if (!authorizationOptions.managedEnvironmentResolver) {
          await provisionManagedObjects(requestedEnvironments, {
            store: environmentStore,
            platform: "linux-arm64",
            installMode: loaded.config.developmentEnvironments.install.mode,
            installer: authorizationOptions.runtimeInstaller,
            installerOptions,
            approveInstall: approveManagedInstall,
          });
        }
        return (authorizationOptions.managedEnvironmentResolver ?? resolveManagedEnvironmentPlan)(
          requestedEnvironments,
          { store: environmentStore, platform: "linux-arm64" },
        );
      };

      let processEnvironmentPlan: EnvironmentPlan | undefined;
      let appleEnvironmentPlan: EnvironmentPlan | undefined;
      let appleEnvironmentError: unknown;
      if (requestedBackend === "process") {
        processEnvironmentPlan = await resolveProcessEnvironmentPlan();
      } else if (requestedBackend === "apple-container") {
        appleEnvironmentPlan = await resolveAppleEnvironmentPlan();
      } else if (requestedEnvironments.length > 0) {
        try {
          appleEnvironmentPlan = await resolveAppleEnvironmentPlan();
        } catch (error) {
          appleEnvironmentError = error;
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
      } else if (appleEnvironmentError !== undefined) {
        fallbackReason = `managed Apple environment unavailable: ${errorMessage(appleEnvironmentError)}`;
        processEnvironmentPlan = await resolveProcessEnvironmentPlan();
        activeEnvironmentPlan = processEnvironmentPlan;
        ctx.ui.notify(
          `${fallbackReason}. Falling back to the Process sandbox.`,
          "warning",
        );
      } else {
        try {
          await appleContainer.preflight(loaded.config.isolation.appleContainer, ctx.cwd);
          effectiveBackend = "apple-container";
          activeEnvironmentPlan = appleEnvironmentPlan;
        } catch (error) {
          fallbackReason = errorMessage(error);
          processEnvironmentPlan = await resolveProcessEnvironmentPlan();
          activeEnvironmentPlan = processEnvironmentPlan;
          ctx.ui.notify(
            `Apple Container prerequisites are not satisfied (${fallbackReason}). Falling back to the Process sandbox. Use --sandbox-mode apple-container to require VM isolation.`,
            "warning",
          );
        }
      }

      const managedProfiles = activeEnvironmentPlan?.profiles.filter((profile) => profile.source === "managed") ?? [];
      if (managedProfiles.length > 0 && !authorizationOptions.managedEnvironmentResolver) {
        environmentLeaseId = `${ctx.sessionManager.getSessionId()}:${process.pid}`;
        for (const profile of managedProfiles) {
          await environmentStore.acquireLease(
            environmentLeaseId,
            activeEnvironmentPlan!.platform,
            profile.id,
            profile.version,
          );
        }
      }
      const installConfig = loaded.config.developmentEnvironments.install;
      await environmentStore.prune({
        maxBytes: parseEnvironmentStoreSize(installConfig.maxSize),
        retentionDays: installConfig.retentionDays,
      });

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
        && environmentExecutable(activeEnvironmentPlan, "kubectl")
      ) {
        try {
          const remembered = loaded.config.kubernetes.persistContextSelection
            ? [...rememberedKubernetesContexts]
            : [];
          if (remembered.length === 0) {
            await grantKubernetesContext(undefined, ctx);
          } else if (await ctx.ui.confirm(
            "Reauthorize remembered Kubernetes contexts?",
            `${remembered.join(", ")} were selected previously. Reauthorize them for this session?`,
          )) {
            for (const contextName of remembered) await grantKubernetesContext(contextName, ctx);
          }
        } catch (error) {
          ctx.ui.notify(`Kubernetes context was not authorized: ${errorMessage(error)}`, "warning");
        }
      }
    } catch (error) {
      if (environmentLeaseId) await environmentStore.releaseLease(environmentLeaseId).catch(() => undefined);
      environmentLeaseId = undefined;
      await runtime.reset().catch(() => undefined);
      initialized = false;
      state = {
        mode: "blocked",
        reason: `initialization failed: ${errorMessage(error)}`,
        loaded,
        requestedBackend,
      };
      setStatus(ctx, state);
      ctx.ui.notify(`Sandbox ${state.reason}. Bash is blocked; use --no-sandbox only for an explicit bypass.`, "error");
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    await kubernetesAccess?.stop().catch(() => undefined);
    kubernetesAccess = undefined;
    if (environmentLeaseId) await environmentStore.releaseLease(environmentLeaseId).catch(() => undefined);
    environmentLeaseId = undefined;
    const containerBinary = state.loaded?.config.isolation.appleContainer.binary;
    if (containerBinary) await appleContainer.stopAll(containerBinary);
    await tracker.stopAll();
    readAuthorization.revoke();
    writeAuthorization.revoke();
    approvedKubernetesExecInvocations.clear();
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
      if (trimmed.toLowerCase() === "kube") {
        ctx.ui.notify(formatKubernetesGrants(kubernetesAccess?.list() ?? []), "info");
        return;
      }
      if (trimmed.toLowerCase() === "kube revoke-all") {
        await kubernetesAccess?.revokeAll();
        clearKubernetesEnvironment();
        ctx.ui.notify("Revoked all Kubernetes context grants for this session.", "info");
        return;
      }
      if (trimmed.toLowerCase().startsWith("kube revoke ")) {
        const contextName = unquote(trimmed.slice("kube revoke ".length).trim());
        await kubernetesAccess?.revoke(contextName);
        if (activeEnvironmentPlan && (kubernetesAccess?.list().length ?? 0) === 0) {
          clearKubernetesEnvironment();
        }
        ctx.ui.notify(`Revoked Kubernetes context grant: ${contextName}`, "info");
        return;
      }
      if (trimmed.toLowerCase() === "kube select" || trimmed.toLowerCase().startsWith("kube select ")) {
        await grantKubernetesContext(trimmed.slice("kube select".length).trim(), ctx);
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
  const usesAppleContainer = state.effectiveBackend === "apple-container";
  lines.push(
    `Configuration: ${loaded.loadedFrom.join(", ") || "built-in defaults"}`,
    `Requested backend: ${state.requestedBackend ?? "not resolved"}`,
    `Effective backend: ${state.effectiveBackend ?? "not active"}`,
    "",
    "Isolation:",
    `  Host launcher: ${usesAppleContainer ? "trusted fixed argv (Apple XPC is incompatible with Seatbelt)" : "ASRT (Seatbelt/bubblewrap)"}`,
    `  Apple Container VM: ${usesAppleContainer ? "enabled" : "disabled"}`,
    `  Guest process: ${usesAppleContainer ? "ASRT (bubblewrap + proxy; VM isolates host IPC)" : "not applicable"}`,
    `  Workspace: ${usesAppleContainer ? config.isolation.appleContainer.workspaceMode : "direct"}`,
    `  Policy parity: ${usesAppleContainer ? "strict (transactional workspace)" : "process backend"}`,
    "",
    "Development environments:",
    ...(state.environmentPlan?.profiles.length
      ? state.environmentPlan.profiles.map((profile) => (
          `  ${profile.id}: ${profile.version} (${profile.source}, ${state.environmentPlan?.platform})`
        ))
      : ["  (none)"]),
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

function formatEnvironmentRequests(requests: RequestedEnvironment[]): string {
  return requests
    .map((request) => `${request.id}@${request.requestedVersion ?? "unspecified"}`)
    .join(", ");
}

function environmentExecutable(
  plan: EnvironmentPlan | undefined,
  id: "kubectl",
): string | undefined {
  const profile = plan?.profiles.find((candidate) => candidate.id === id);
  if (!profile) return undefined;
  for (const directory of profile.binDirectories) {
    const executable = join(directory, id);
    if (existsSync(executable)) return executable;
  }
  return undefined;
}

function formatKubernetesExecInvocation(metadata: {
  execCommand?: string;
  execArgs?: string[];
  execEnvironmentNames?: string[];
}): string {
  const command = [metadata.execCommand, ...(metadata.execArgs ?? [])]
    .filter((value): value is string => value !== undefined)
    .map((value) => JSON.stringify(value))
    .join(" ");
  const environment = metadata.execEnvironmentNames?.length
    ? `\nConfigured environment names (values remain on host): ${metadata.execEnvironmentNames.join(", ")}`
    : "";
  return `${command}${environment}`;
}

function formatKubernetesGrants(grants: KubernetesSessionGrantSummary[]): string {
  if (grants.length === 0) return "Kubernetes context grants: (none)";
  return [
    "Kubernetes context grants:",
    ...grants.flatMap((grant) => [
      `  ${grant.context} (${grant.cluster})`,
      `    access: ${grant.access}`,
      `    namespaces: ${grant.namespaces?.join(", ") || "all"}`,
      `    authentication: ${grant.authentication}`,
    ]),
  ].join("\n");
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
