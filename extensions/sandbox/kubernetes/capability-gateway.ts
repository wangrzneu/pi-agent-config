import { randomBytes, randomUUID } from "node:crypto";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import https from "node:https";

export type KubernetesGrantAccess = "observe" | "rbac";

export interface KubernetesGatewayGrantRequest {
  context: string;
  upstream: string;
  access: KubernetesGrantAccess;
  namespaces?: string[];
}

export interface KubernetesGatewayTlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
}

export interface KubernetesCapabilityGatewayOptions {
  tls?: KubernetesGatewayTlsOptions;
  listenHost?: string;
  advertiseHost?: string;
}

export interface KubernetesGatewayGrant {
  id: string;
  context: string;
  capability: string;
  server: string;
}

interface StoredGrant extends KubernetesGatewayGrant {
  upstream: URL;
  access: KubernetesGrantAccess;
  namespaces?: Set<string>;
  controller: AbortController;
}

export class KubernetesCapabilityGateway {
  private server?: Server;
  private origin?: string;
  private readonly grants = new Map<string, StoredGrant>();
  private readonly grantIdsByCapability = new Map<string, string>();
  private readonly options: KubernetesCapabilityGatewayOptions;

  constructor(options: KubernetesCapabilityGatewayOptions = {}) {
    this.options = options;
  }

  async start(): Promise<string> {
    if (this.server && this.origin) return this.origin;
    const handler = (request: http.IncomingMessage, response: http.ServerResponse) => {
      void this.handle(request, response);
    };
    const server = this.options.tls
      ? https.createServer(this.options.tls, handler)
      : http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.options.listenHost ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Kubernetes capability gateway did not receive a TCP address");
    }
    this.server = server;
    const advertisedHost = this.options.advertiseHost ?? this.options.listenHost ?? "127.0.0.1";
    this.origin = `${this.options.tls ? "https" : "http"}://${formatUrlHost(advertisedHost)}:${address.port}`;
    return this.origin;
  }

  grant(request: KubernetesGatewayGrantRequest): KubernetesGatewayGrant {
    if (!this.origin) throw new Error("Kubernetes capability gateway must be started before granting contexts");
    if (!request.context) throw new Error("Kubernetes context name cannot be empty");
    if (request.access !== "observe" && request.access !== "rbac") {
      throw new Error("Kubernetes grant access must be observe or rbac");
    }
    const upstream = validateLoopbackUpstream(request.upstream);
    const id = randomUUID();
    const capability = randomBytes(32).toString("base64url");
    const grant: StoredGrant = {
      id,
      context: request.context,
      capability,
      // Kubernetes clients resolve discovery paths such as /version from the
      // origin and do not reliably preserve a server URL path prefix. Route by
      // the opaque bearer capability instead of embedding the grant id in PATH.
      server: this.origin,
      upstream,
      access: request.access,
      namespaces: request.namespaces ? new Set(request.namespaces) : undefined,
      controller: new AbortController(),
    };
    this.grants.set(id, grant);
    this.grantIdsByCapability.set(capability, id);
    return publicGrant(grant);
  }

  revoke(id: string): void {
    const grant = this.grants.get(id);
    if (grant) {
      this.grantIdsByCapability.delete(grant.capability);
      grant.controller.abort();
    }
    this.grants.delete(id);
  }

  revokeAll(): void {
    for (const grant of this.grants.values()) grant.controller.abort();
    this.grants.clear();
    this.grantIdsByCapability.clear();
  }

  async stop(): Promise<void> {
    this.revokeAll();
    const server = this.server;
    this.server = undefined;
    this.origin = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      const incoming = new URL(request.url ?? "/", "http://gateway.invalid");
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;
      const grantId = token ? this.grantIdsByCapability.get(token) : undefined;
      const grant = grantId ? this.grants.get(grantId) : undefined;
      if (!grant) return send(response, 401, "Invalid Kubernetes session capability");
      const upstreamPath = incoming.pathname;
      const policyPath = decodePolicyPath(upstreamPath);
      if (!policyPath || !isAllowed(grant, request.method ?? "GET", policyPath)) {
        return send(response, 403, "Kubernetes request is outside the granted session policy");
      }
      await proxyRequest(
        request,
        response,
        grant.upstream,
        `${upstreamPath}${incoming.search}`,
        grant.controller.signal,
      );
    } catch {
      if (!response.headersSent) send(response, 502, "Kubernetes gateway request failed");
      else response.destroy();
    }
  }
}

function publicGrant(grant: StoredGrant): KubernetesGatewayGrant {
  return {
    id: grant.id,
    context: grant.context,
    capability: grant.capability,
    server: grant.server,
  };
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function validateLoopbackUpstream(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Kubernetes broker upstream URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Kubernetes broker upstream must use HTTP or HTTPS");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Kubernetes broker upstream must be loopback-only");
  }
  return url;
}

function decodePolicyPath(path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  // A second encoded octet is ambiguous across the Node gateway, kubectl's Go
  // proxy, and the API server. Reject rather than risk downstream re-decoding.
  if (/%[0-9a-f]{2}/i.test(decoded) || /[\\\0-\x1f\x7f]/.test(decoded)) return undefined;
  return decoded;
}

function isAllowed(grant: StoredGrant, method: string, path: string): boolean {
  if (grant.access === "observe") {
    if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return false;
    if (/\/(?:exec|attach|portforward|proxy|eviction)(?:\/|$)/.test(path)) return false;
  }
  if (!grant.namespaces || grant.namespaces.size === 0) return true;
  if (isDiscoveryPath(path)) return true;
  const namespaceMatch = path.match(/\/namespaces\/([^/]+)(?:\/|$)/);
  if (!namespaceMatch) return false;
  let namespace: string;
  try {
    namespace = decodeURIComponent(namespaceMatch[1]);
  } catch {
    return false;
  }
  return grant.namespaces.has(namespace);
}

function isDiscoveryPath(path: string): boolean {
  return /^\/(?:version|openapi(?:\/.*)?|healthz|readyz|livez)\/?$/.test(path)
    || /^\/api(?:\/[^/]+)?\/?$/.test(path)
    || /^\/apis(?:\/[^/]+(?:\/[^/]+)?)?\/?$/.test(path);
}

function proxyRequest(
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
  upstream: URL,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transport = upstream.protocol === "https:" ? https : http;
    const headers = sanitizedHeaders(incoming.headers, upstream);
    const proxied = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: incoming.method,
      path: joinUrlPaths(upstream.pathname, path),
      headers,
      timeout: 30_000,
      signal,
    }, (result) => {
      outgoing.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(outgoing);
      result.once("end", resolve);
      result.once("error", reject);
    });
    proxied.once("timeout", () => proxied.destroy(new Error("Kubernetes broker upstream timed out")));
    proxied.once("error", reject);
    incoming.pipe(proxied);
  });
}

function sanitizedHeaders(headers: IncomingHttpHeaders, upstream: URL): IncomingHttpHeaders {
  const copy = { ...headers };
  delete copy.authorization;
  delete copy["proxy-authorization"];
  delete copy.connection;
  delete copy.upgrade;
  copy.host = upstream.host;
  return copy;
}

function joinUrlPaths(prefix: string, path: string): string {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}` || "/";
}

function send(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}
