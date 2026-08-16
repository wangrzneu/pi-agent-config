import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KubernetesConfig } from "../config.ts";
import { resolveLocalEnvironments } from "../environments/local-resolver.ts";
import type { EnvironmentPlan } from "../environments/types.ts";
import { SANDBOX_TEMP_ROOT } from "../sandbox-paths.ts";
import { errorMessage } from "../util.ts";
import { resolveAppleContainerHostGateway } from "./apple-bridge.ts";
import { KubernetesCapabilityGateway } from "./capability-gateway.ts";
import { KubernetesContextSelectionStore } from "./context-selection-store.ts";
import {
  discoverKubernetesContexts,
  type KubernetesContextMetadata,
} from "./context-source.ts";
import { KubectlProxyBroker } from "./proxy-broker.ts";
import {
  KubernetesSessionAccess,
  type KubernetesSessionGrantSummary,
} from "./session-access.ts";
import { createKubernetesGatewayTlsMaterial } from "./tls-material.ts";

const APPLE_KUBERNETES_DIRECTORY = "/opt/pi-kube";
const APPLE_KUBECONFIG_PATH = `${APPLE_KUBERNETES_DIRECTORY}/config.json`;

type EffectiveBackend = "process" | "apple-container";

export interface KubernetesControllerState {
  active: boolean;
  effectiveBackend?: EffectiveBackend;
  config?: KubernetesConfig;
}

export interface KubernetesControllerOptions {
  state: () => KubernetesControllerState;
  environmentPlan: () => EnvironmentPlan | undefined;
  environmentResolver?: typeof resolveLocalEnvironments;
  contextDiscovery?: typeof discoverKubernetesContexts;
  accessFactory?: () => Promise<KubernetesSessionAccess>;
  appleContainerBinary?: () => string | undefined;
  selectionStore: KubernetesContextSelectionStore;
}

export class SandboxKubernetesController {
  private readonly options: KubernetesControllerOptions;
  private access?: KubernetesSessionAccess;
  private readonly approvedExecInvocations = new Set<string>();
  private readonly rememberedContexts = new Set<string>();

  constructor(options: KubernetesControllerOptions) {
    this.options = options;
  }

  get kubeconfigPath(): string | undefined {
    return this.access?.kubeconfigPath;
  }

  list(): KubernetesSessionGrantSummary[] {
    return this.access?.list() ?? [];
  }

  async initializeSession(ctx: ExtensionContext, config: KubernetesConfig): Promise<void> {
    await this.access?.stop().catch(() => undefined);
    this.access = undefined;
    this.approvedExecInvocations.clear();
    this.rememberedContexts.clear();
    if (!config.persistContextSelection) return;
    try {
      for (const contextName of await this.options.selectionStore.load(ctx.cwd)) {
        this.rememberedContexts.add(contextName);
      }
    } catch (error) {
      ctx.ui.notify(`Persisted Kubernetes context selection was ignored: ${errorMessage(error)}`, "warning");
    }
  }

  async promptOnStart(ctx: ExtensionContext): Promise<void> {
    if (!hasProfile(this.options.environmentPlan(), "kubectl")) return;
    const remembered = this.options.state().config?.persistContextSelection
      ? [...this.rememberedContexts]
      : [];
    if (remembered.length === 0) {
      await this.grant(undefined, ctx);
      return;
    }
    if (!await ctx.ui.confirm(
      "Reauthorize remembered Kubernetes contexts?",
      `${remembered.join(", ")} were selected previously. Reauthorize them for this session?`,
    )) return;
    for (const contextName of remembered) await this.grant(contextName, ctx);
  }

  async grant(requestedContextName: string | undefined, ctx: ExtensionContext): Promise<boolean> {
    const state = this.requireActiveState();
    const kubectl = await this.hostKubectlExecutable(ctx, state.effectiveBackend);
    const discovered = await (this.options.contextDiscovery ?? discoverKubernetesContexts)({
      kubectl,
      env: process.env,
    });
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
    await this.approveExecHelper(contextName, metadata, ctx);

    const access = await this.ensureAccess(state.effectiveBackend);
    const config = state.config;
    await access.grant({
      metadata,
      kubectl,
      env: process.env,
      access: config.defaultAccess,
      namespaces: config.defaultNamespaces === "all"
        ? undefined
        : [metadata.namespace ?? "default"],
    });
    this.applyEnvironment(access.kubeconfigPath, state.effectiveBackend);
    if (config.persistContextSelection) {
      this.rememberedContexts.add(contextName);
      try {
        await this.options.selectionStore.save(ctx.cwd, [...this.rememberedContexts]);
      } catch (error) {
        ctx.ui.notify(`Kubernetes context selection could not be persisted: ${errorMessage(error)}`, "warning");
      }
    }
    ctx.ui.notify(
      `Authorized Kubernetes context for this session: ${contextName}\nAccess: ${config.defaultAccess}\nNamespaces: ${config.defaultNamespaces === "all" ? "all" : metadata.namespace ?? "default"}${metadata.sourceFile ? `\nSource: ${metadata.sourceFile}` : ""}`,
      "info",
    );
    return true;
  }

  async revoke(contextName: string): Promise<void> {
    await this.access?.revoke(contextName);
    if (this.list().length === 0) this.clearEnvironment();
  }

  async revokeAll(): Promise<void> {
    await this.access?.revokeAll();
    this.clearEnvironment();
  }

  async forget(ctx: ExtensionContext): Promise<void> {
    this.rememberedContexts.clear();
    await this.options.selectionStore.clear(ctx.cwd);
  }

  async stop(): Promise<void> {
    await this.access?.stop().catch(() => undefined);
    this.access = undefined;
    this.clearEnvironment();
  }

  private requireActiveState(): { effectiveBackend: EffectiveBackend; config: KubernetesConfig } {
    const state = this.options.state();
    if (!state.active || !state.effectiveBackend || !state.config) {
      throw new Error("Kubernetes access requires an active sandbox");
    }
    return { effectiveBackend: state.effectiveBackend, config: state.config };
  }

  private async hostKubectlExecutable(
    ctx: ExtensionContext,
    backend: EffectiveBackend,
  ): Promise<string> {
    if (!hasProfile(this.options.environmentPlan(), "kubectl")) {
      throw new Error("Select the kubectl development environment before granting Kubernetes contexts");
    }
    if (backend === "process") {
      const executable = profileExecutable(this.options.environmentPlan(), "kubectl");
      if (!executable) throw new Error("Selected kubectl executable is unavailable on the host");
      return executable;
    }
    const resolver = this.options.environmentResolver ?? resolveLocalEnvironments;
    const [hostProfile] = await resolver([{ id: "kubectl" }], { cwd: ctx.cwd, env: process.env });
    const executable = hostProfile?.binDirectories[0]
      ? join(hostProfile.binDirectories[0], "kubectl")
      : undefined;
    if (!executable || !existsSync(executable)) {
      throw new Error("Apple Container Kubernetes access requires a trusted host kubectl for the credential broker");
    }
    return executable;
  }

  private async ensureAccess(backend: EffectiveBackend): Promise<KubernetesSessionAccess> {
    if (this.access) return this.access;
    if (this.options.accessFactory) {
      this.access = await this.options.accessFactory();
      return this.access;
    }
    const gatewayHost = backend === "apple-container"
      ? await resolveAppleContainerHostGateway({ containerBinary: this.options.appleContainerBinary?.() })
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
    this.access = new KubernetesSessionAccess({
      broker: new KubectlProxyBroker(),
      gateway,
      kubeconfigPath: join(SANDBOX_TEMP_ROOT, "kubernetes", "config.json"),
      gatewayCaData: tls.caData,
    });
    return this.access;
  }

  private async approveExecHelper(
    contextName: string,
    metadata: KubernetesContextMetadata,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (!metadata.execCommand) return;
    const approvalKey = JSON.stringify([
      contextName,
      metadata.execCommand,
      metadata.execArgs ?? [],
      metadata.execEnvironmentNames ?? [],
    ]);
    if (this.approvedExecInvocations.has(approvalKey)) return;
    if (!ctx.hasUI) throw new Error("Kubernetes credential helper approval requires an interactive UI");
    const approved = await ctx.ui.confirm(
      "Run Kubernetes credential helper on the host?",
      `Context ${contextName} authenticates with:\n${formatExecInvocation(metadata)}\nAllow this exact host credential-helper invocation for this session?`,
    );
    if (!approved) throw new Error("Kubernetes credential helper was not approved");
    this.approvedExecInvocations.add(approvalKey);
  }

  private applyEnvironment(kubeconfigPath: string, backend: EffectiveBackend): void {
    const plan = this.options.environmentPlan();
    if (!plan) return;
    if (backend === "apple-container") {
      plan.env.KUBECONFIG = APPLE_KUBECONFIG_PATH;
      plan.mounts = [
        ...(plan.mounts ?? []).filter((mount) => mount.target !== APPLE_KUBERNETES_DIRECTORY),
        { source: join(kubeconfigPath, ".."), target: APPLE_KUBERNETES_DIRECTORY, readonly: true },
      ];
      if (!plan.allowRead.includes(APPLE_KUBECONFIG_PATH)) plan.allowRead.push(APPLE_KUBECONFIG_PATH);
    } else {
      plan.env.KUBECONFIG = kubeconfigPath;
    }
  }

  private clearEnvironment(): void {
    const plan = this.options.environmentPlan();
    if (!plan) return;
    plan.env.KUBECONFIG = undefined;
    plan.mounts = plan.mounts?.filter((mount) => mount.target !== APPLE_KUBERNETES_DIRECTORY);
    plan.allowRead = plan.allowRead.filter((path) => path !== APPLE_KUBECONFIG_PATH);
  }
}

export function formatKubernetesGrants(grants: KubernetesSessionGrantSummary[]): string {
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

function hasProfile(plan: EnvironmentPlan | undefined, id: "kubectl"): boolean {
  return plan?.profiles.some((profile) => profile.id === id) === true;
}

function profileExecutable(plan: EnvironmentPlan | undefined, id: "kubectl"): string | undefined {
  const profile = plan?.profiles.find((candidate) => candidate.id === id);
  if (!profile) return undefined;
  for (const directory of profile.binDirectories) {
    const executable = join(directory, id);
    if (existsSync(executable)) return executable;
  }
  return undefined;
}

function formatExecInvocation(metadata: KubernetesContextMetadata): string {
  const command = [metadata.execCommand, ...(metadata.execArgs ?? [])]
    .filter((value): value is string => value !== undefined)
    .map((value) => JSON.stringify(value))
    .join(" ");
  const environment = metadata.execEnvironmentNames?.length
    ? `\nConfigured environment names (values remain on host): ${metadata.execEnvironmentNames.join(", ")}`
    : "";
  return `${command}${environment}`;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.at(-1) === first) return value.slice(1, -1);
  }
  return value;
}
