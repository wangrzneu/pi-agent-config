import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { KubernetesCapabilityGateway } from "./capability-gateway.ts";
import { KubectlProxyBroker } from "./proxy-broker.ts";
import { createSanitizedKubeconfig } from "./sanitized-kubeconfig.ts";

const execFileAsync = promisify(execFile);
const integrationTest = process.env.PI_SANDBOX_KUBERNETES_INTEGRATION === "1" ? test : test.skip;

integrationTest("real kubectl reaches only the granted API through sanitized kubeconfig", async () => {
  const upstream = http.createServer((request, response) => {
    const requested = new URL(request.url ?? "/", "http://fixture.invalid");
    if (requested.pathname !== "/version") {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      major: "1",
      minor: "32",
      gitVersion: "v1.32.3",
      gitCommit: "fixture",
      gitTreeState: "clean",
      buildDate: "2026-01-01T00:00:00Z",
      goVersion: "go1.24.2",
      compiler: "gc",
      platform: "linux/arm64",
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const temp = await mkdtemp(join(tmpdir(), "pi-kube-gateway-e2e-"));
  const keyPath = join(temp, "gateway.key");
  const certPath = join(temp, "gateway.crt");
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { timeout: 30_000 });
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const kubectl = findOnPath("kubectl");
  assert.ok(kubectl, "kubectl is required for this integration test");
  const hostKubeconfigPath = join(temp, "host-config.json");
  await writeFile(hostKubeconfigPath, JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: "fixture", cluster: { server: upstreamUrl } }],
    users: [{ name: "fixture", user: {} }],
    contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
    "current-context": "fixture",
  }), { mode: 0o600 });
  const broker = new KubectlProxyBroker();
  const proxy = await broker.start({
    kubectl,
    context: "fixture",
    env: { KUBECONFIG: hostKubeconfigPath },
  });
  const gateway = new KubernetesCapabilityGateway({ tls: { key, cert } });
  await gateway.start();
  try {
    const grant = gateway.grant({ context: "fixture", upstream: proxy.upstream, access: "observe" });
    const kubeconfig = createSanitizedKubeconfig([{
      context: "fixture",
      cluster: "fixture",
      gatewayServer: grant.server,
      gatewayCaData: cert.toString("base64"),
      capability: grant.capability,
    }], "fixture");
    const kubeconfigPath = join(temp, "config.json");
    await writeFile(kubeconfigPath, kubeconfig, { mode: 0o600 });
    const result = await execFileAsync(kubectl, [
      "--kubeconfig", kubeconfigPath,
      "version",
      "-o", "json",
    ], { encoding: "utf8", timeout: 30_000 });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.serverVersion.gitVersion, "v1.32.3");

    gateway.revoke(grant.id);
    await assert.rejects(execFileAsync(kubectl, [
      "--kubeconfig", kubeconfigPath,
      "version",
      "-o", "json",
    ], { encoding: "utf8", timeout: 30_000 }), /Command failed/);
  } finally {
    await gateway.stop();
    await broker.stopAll();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

function findOnPath(command) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (directory) {
      const candidate = join(directory, command);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
