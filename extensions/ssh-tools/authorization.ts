import type { SshCapability } from "./tool-activation.ts";

export interface ConnectionRetryPolicy {
  connectTimeoutSeconds: number;
  retries: number;
  retryDelayMs: number;
}

export const DEFAULT_CONNECTION_POLICY: ConnectionRetryPolicy = {
  connectTimeoutSeconds: 10,
  retries: 2,
  retryDelayMs: 500,
};

export class SshAuthorization {
  private readonly connectedHosts = new Set<string>();
  /** Capability grants are session-scoped, keyed by host. */
  private readonly sessionGrants = new Map<string, Set<SshCapability>>();
  private readonly policies = new Map<string, ConnectionRetryPolicy>();

  isConnected(host: string): boolean {
    return this.connectedHosts.has(host);
  }

  getHosts(): string[] {
    return [...this.connectedHosts];
  }

  missingCapabilities(host: string, requested: readonly SshCapability[]): SshCapability[] {
    const granted = this.sessionGrants.get(host);
    return [...new Set(requested)].filter((capability) => !granted?.has(capability));
  }

  grant(
    host: string,
    capabilities: readonly SshCapability[],
    policy: ConnectionRetryPolicy,
  ): void {
    this.connectedHosts.add(host);
    const granted = this.sessionGrants.get(host) ?? new Set<SshCapability>();
    for (const capability of capabilities) granted.add(capability);
    this.sessionGrants.set(host, granted);
    this.policies.set(host, { ...policy });
  }

  assertCapability(host: string, capability: SshCapability): void {
    if (!this.connectedHosts.has(host)) {
      throw new Error(`SSH host ${host} is not authorized. Call ssh_enable first.`);
    }
    if (!this.sessionGrants.get(host)?.has(capability)) {
      throw new Error(`SSH capability ${capability} is not authorized for ${host} in this session. Call ssh_enable first.`);
    }
  }

  policyFor(host: string): ConnectionRetryPolicy {
    return { ...(this.policies.get(host) ?? DEFAULT_CONNECTION_POLICY) };
  }

  clearGrants(): void {
    this.sessionGrants.clear();
  }

  reset(): void {
    this.connectedHosts.clear();
    this.sessionGrants.clear();
    this.policies.clear();
  }
}
