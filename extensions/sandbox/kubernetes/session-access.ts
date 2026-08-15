import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KubernetesContextMetadata } from "./context-source.ts";
import type {
  KubernetesGatewayGrant,
  KubernetesGatewayGrantRequest,
  KubernetesGrantAccess,
} from "./capability-gateway.ts";
import type { KubectlProxyHandle, KubectlProxyStartRequest } from "./proxy-broker.ts";
import { createSanitizedKubeconfig } from "./sanitized-kubeconfig.ts";

interface ProxyBroker {
  start(request: KubectlProxyStartRequest): Promise<KubectlProxyHandle>;
  stop(id: string): Promise<void>;
  stopAll(): Promise<void>;
}

interface CapabilityGateway {
  grant(request: KubernetesGatewayGrantRequest): KubernetesGatewayGrant;
  revoke(id: string): void;
  stop(): Promise<void>;
}

export interface KubernetesSessionAccessOptions {
  broker: ProxyBroker;
  gateway: CapabilityGateway;
  kubeconfigPath: string;
  gatewayCaData: string;
}

export interface KubernetesSessionGrantRequest {
  metadata: KubernetesContextMetadata;
  kubectl: string;
  env: NodeJS.ProcessEnv;
  access: KubernetesGrantAccess;
  namespaces?: string[];
}

export interface KubernetesSessionGrantSummary {
  context: string;
  cluster: string;
  namespace?: string;
  access: KubernetesGrantAccess;
  namespaces?: string[];
  authentication: string;
}

interface ActiveGrant {
  request: KubernetesSessionGrantRequest;
  proxy: KubectlProxyHandle;
  gateway: KubernetesGatewayGrant;
}

export class KubernetesSessionAccess {
  readonly kubeconfigPath: string;
  private readonly broker: ProxyBroker;
  private readonly gateway: CapabilityGateway;
  private readonly gatewayCaData: string;
  private readonly grants = new Map<string, ActiveGrant>();

  constructor(options: KubernetesSessionAccessOptions) {
    this.broker = options.broker;
    this.gateway = options.gateway;
    this.kubeconfigPath = options.kubeconfigPath;
    this.gatewayCaData = options.gatewayCaData;
  }

  async grant(request: KubernetesSessionGrantRequest): Promise<void> {
    if (this.grants.has(request.metadata.name)) return;
    const proxy = await this.broker.start({
      kubectl: request.kubectl,
      context: request.metadata.name,
      env: request.env,
    });
    let gateway: KubernetesGatewayGrant | undefined;
    try {
      gateway = this.gateway.grant({
        context: request.metadata.name,
        upstream: proxy.upstream,
        access: request.access,
        namespaces: request.namespaces,
      });
      this.grants.set(request.metadata.name, { request, proxy, gateway });
      await this.writeKubeconfig();
    } catch (error) {
      if (gateway) this.gateway.revoke(gateway.id);
      this.grants.delete(request.metadata.name);
      await this.broker.stop(proxy.id).catch(() => undefined);
      throw error;
    }
  }

  async revoke(context: string): Promise<void> {
    const grant = this.grants.get(context);
    if (!grant) return;
    this.grants.delete(context);
    this.gateway.revoke(grant.gateway.id);
    await this.broker.stop(grant.proxy.id);
    await this.writeKubeconfig();
  }

  async revokeAll(): Promise<void> {
    for (const context of [...this.grants.keys()]) await this.revoke(context);
  }

  list(): KubernetesSessionGrantSummary[] {
    return [...this.grants.values()].map(({ request }) => ({
      context: request.metadata.name,
      cluster: request.metadata.cluster,
      namespace: request.metadata.namespace,
      access: request.access,
      namespaces: request.namespaces ? [...request.namespaces] : undefined,
      authentication: request.metadata.authentication,
    }));
  }

  async stop(): Promise<void> {
    this.grants.clear();
    await Promise.allSettled([this.broker.stopAll(), this.gateway.stop()]);
  }

  private async writeKubeconfig(): Promise<void> {
    const grants = [...this.grants.values()];
    if (grants.length === 0) {
      await rm(this.kubeconfigPath, { force: true });
      return;
    }
    const content = createSanitizedKubeconfig(
      grants.map(({ request, gateway }) => ({
        context: request.metadata.name,
        cluster: request.metadata.cluster,
        namespace: request.metadata.namespace,
        gatewayServer: gateway.server,
        gatewayCaData: this.gatewayCaData,
        capability: gateway.capability,
      })),
      grants[0]?.request.metadata.name,
    );
    await mkdir(dirname(this.kubeconfigPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.kubeconfigPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.kubeconfigPath);
  }
}
