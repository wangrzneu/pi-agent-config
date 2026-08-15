import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AppleContainerController,
  createAppleContainerBashOperations,
} from "../apple-container.ts";
import { DEFAULT_SANDBOX_CONFIG } from "../config.ts";
import { SandboxProcessTracker } from "../process.ts";
import { ensureSandboxTempRoot } from "../sandbox-paths.ts";
import { resolveManagedEnvironmentPlan } from "./managed-resolver.ts";
import { EnvironmentStore } from "./store.ts";

const integrationTest = process.env.PI_SANDBOX_ENV_APPLE_INTEGRATION === "1" ? test : test.skip;

async function publishFixture(store, id, version, digestCharacter, body) {
  const staging = await store.createStagingDirectory(id);
  await mkdir(join(staging, "bin"));
  await writeFile(join(staging, "bin", id === "python" ? "python" : id), body, { mode: 0o755 });
  await store.publish({
    stagingPath: staging,
    digest: digestCharacter.repeat(64),
    platform: "linux-arm64",
    profile: id,
    version,
  });
}

integrationTest("managed Go, Python, Node.js, pnpm, and kubectl execute together in Apple Container", async () => {
  await ensureSandboxTempRoot();
  const workspace = await mkdtemp(join(tmpdir(), "pi-apple-env-e2e-workspace-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "pi-apple-env-e2e-store-"));
  const kubeDirectory = await mkdtemp(join(tmpdir(), "pi-apple-kube-e2e-"));
  await writeFile(join(kubeDirectory, "config.json"), "sanitized-kubeconfig");
  const store = new EnvironmentStore(storeRoot);
  await store.initialize();
  await publishFixture(store, "go", "1.24.2", "1", "#!/bin/sh\necho 'go version go1.24.2 linux/arm64'\n");
  await publishFixture(store, "python", "3.13.2", "2", "#!/bin/sh\necho 'Python 3.13.2'\n");
  await publishFixture(store, "node", "22.14.0", "3", "#!/bin/sh\necho 'v22.14.0'\n");
  await publishFixture(store, "pnpm", "10.6.0", "4", "#!/bin/sh\necho '10.6.0'\n");
  await publishFixture(store, "kubectl", "1.32.3", "5", "#!/bin/sh\necho '{\"clientVersion\":{\"gitVersion\":\"v1.32.3\"}}'\n");

  const plan = await resolveManagedEnvironmentPlan([
    { id: "go", requestedVersion: "1.24.2" },
    { id: "python", requestedVersion: "3.13.2" },
    { id: "node", requestedVersion: "22.14.0" },
    { id: "pnpm", requestedVersion: "10.6.0" },
    { id: "kubectl", requestedVersion: "1.32.3" },
  ], { store, platform: "linux-arm64" });

  let selectedPlan = plan;
  const controller = new AppleContainerController();
  const tracker = new SandboxProcessTracker();
  const container = {
    ...DEFAULT_SANDBOX_CONFIG.isolation.appleContainer,
    image: process.env.PI_SANDBOX_TEST_IMAGE ?? DEFAULT_SANDBOX_CONFIG.isolation.appleContainer.image,
  };
  await controller.preflight(container, workspace);
  const operations = createAppleContainerBashOperations(controller, {
    tracker,
    container,
    policy: () => ({ config: DEFAULT_SANDBOX_CONFIG, readGrants: [], writeGrants: [] }),
    gitIdentity: () => undefined,
    authorizeNetwork: async () => false,
    environment: () => selectedPlan,
  });
  const chunks = [];
  try {
    const result = await operations.exec(
      "go version && python --version && node --version && pnpm --version && kubectl version --client -o json",
      workspace,
      { onData: (chunk) => chunks.push(chunk), timeout: 60 },
    );
    const output = Buffer.concat(chunks).toString("utf8");
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /go version go1\.24\.2 linux\/arm64/);
    assert.match(output, /Python 3\.13\.2/);
    assert.match(output, /v22\.14\.0/);
    assert.match(output, /10\.6\.0/);
    assert.match(output, /clientVersion/);

    plan.env.KUBECONFIG = "/opt/pi-kube/config.json";
    plan.mounts.push({ source: kubeDirectory, target: "/opt/pi-kube", readonly: true });
    const kubeChunks = [];
    const mountedKubeconfig = await operations.exec("cat \"$KUBECONFIG\"", workspace, {
      onData: (chunk) => kubeChunks.push(chunk),
      timeout: 60,
    });
    assert.equal(mountedKubeconfig.exitCode, 0, Buffer.concat(kubeChunks).toString("utf8"));
    assert.match(Buffer.concat(kubeChunks).toString("utf8"), /sanitized-kubeconfig/);

    selectedPlan = undefined;
    const hiddenChunks = [];
    const hidden = await operations.exec(
      "if command -v node >/dev/null; then echo runner-node-leaked; exit 1; else echo runner-node-hidden; fi",
      workspace,
      { onData: (chunk) => hiddenChunks.push(chunk), timeout: 60 },
    );
    const hiddenOutput = Buffer.concat(hiddenChunks).toString("utf8");
    assert.equal(hidden.exitCode, 0, hiddenOutput);
    assert.match(hiddenOutput, /runner-node-hidden/);
  } finally {
    await controller.stopAll(container.binary);
    await tracker.stopAll();
    await rm(workspace, { recursive: true, force: true });
    await rm(kubeDirectory, { recursive: true, force: true });
    await store.prune({ maxBytes: 0, retentionDays: 0 }).catch(() => undefined);
    await rm(storeRoot, { recursive: true, force: true });
  }
});
