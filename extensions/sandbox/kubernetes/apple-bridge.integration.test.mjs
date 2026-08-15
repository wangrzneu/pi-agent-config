import http from "node:http";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SANDBOX_CONFIG } from "../config.ts";
import { resolveAppleContainerHostGateway } from "./apple-bridge.ts";
import { ensureSandboxTempRoot, SANDBOX_TEMP_ROOT } from "../sandbox-paths.ts";
import { KubernetesCapabilityGateway } from "./capability-gateway.ts";
import { createKubernetesGatewayTlsMaterial } from "./tls-material.ts";

const integrationTest = process.env.PI_SANDBOX_KUBERNETES_APPLE_INTEGRATION === "1"
  ? test
  : test.skip;
const execFileAsync = promisify(execFile);

integrationTest("Apple Container reaches the capability gateway only on the private host bridge", async () => {
  await ensureSandboxTempRoot();
  const host = resolveAppleContainerHostGateway();
  const upstream = http.createServer((_request, response) => response.end('{"bridge":"ok"}'));
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Test upstream did not bind TCP");

  const tls = await createKubernetesGatewayTlsMaterial("", [host]);
  const gateway = new KubernetesCapabilityGateway({
    tls: { key: tls.key, cert: tls.cert },
    listenHost: host,
    advertiseHost: host,
  });
  await gateway.start();
  const grant = gateway.grant({
    context: "apple-bridge-e2e",
    upstream: `http://127.0.0.1:${address.port}`,
    access: "observe",
  });
  await writeFile(join(SANDBOX_TEMP_ROOT, "apple-kube-ca.pem"), tls.cert);
  try {
    const { stdout } = await execFileAsync(DEFAULT_SANDBOX_CONFIG.isolation.appleContainer.binary, [
      "run", "--rm",
      "--entrypoint", "/usr/bin/curl",
      "--mount", `type=bind,source=${SANDBOX_TEMP_ROOT},target=/mnt,readonly`,
      process.env.PI_SANDBOX_TEST_IMAGE ?? DEFAULT_SANDBOX_CONFIG.isolation.appleContainer.image,
      "-fsS", "--max-time", "10",
      "--cacert", "/mnt/apple-kube-ca.pem",
      "-H", `Authorization: Bearer ${grant.capability}`,
      `${grant.server}/version`,
    ], { encoding: "utf8", timeout: 30_000 });
    if (stdout.trim() !== '{"bridge":"ok"}') throw new Error(`Unexpected bridge response: ${stdout}`);
  } finally {
    await gateway.stop();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
