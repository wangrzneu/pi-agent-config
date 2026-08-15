import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppleContainerController, createAppleContainerBashOperations } from "../apple-container.ts";
import { DEFAULT_SANDBOX_CONFIG } from "../config.ts";
import { SandboxProcessTracker } from "../process.ts";
import { ensureSandboxTempRoot } from "../sandbox-paths.ts";
import { installTrustedRuntime } from "./artifact-catalog.ts";
import { resolveManagedEnvironmentPlan } from "./managed-resolver.ts";
import { prepareAppleProjectState } from "./project-state.ts";
import { EnvironmentStore } from "./store.ts";

const integrationTest = process.env.PI_SANDBOX_ENV_APPLE_PROJECT_STATE_INTEGRATION === "1"
  ? test
  : test.skip;

integrationTest("Apple Container creates and reuses a project-scoped Python venv", async () => {
  await ensureSandboxTempRoot();
  const workspace = await mkdtemp(join(tmpdir(), "pi-python-venv-workspace-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "pi-python-venv-store-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-python-project-state-"));
  const store = new EnvironmentStore(storeRoot);
  const controller = new AppleContainerController();
  const tracker = new SandboxProcessTracker();
  const container = {
    ...DEFAULT_SANDBOX_CONFIG.isolation.appleContainer,
    image: process.env.PI_SANDBOX_TEST_IMAGE ?? DEFAULT_SANDBOX_CONFIG.isolation.appleContainer.image,
  };
  try {
    await installTrustedRuntime(store, "python", "3.13.2", "linux-arm64");
    const plan = await resolveManagedEnvironmentPlan([
      { id: "python", requestedVersion: "3.13.2" },
    ], { store, platform: "linux-arm64" });
    await prepareAppleProjectState(plan, { workspace, root: projectRoot });
    await controller.preflight(container, workspace);
    const operations = createAppleContainerBashOperations(controller, {
      tracker,
      container,
      policy: () => ({ config: DEFAULT_SANDBOX_CONFIG, readGrants: [], writeGrants: [] }),
      gitIdentity: () => undefined,
      authorizeNetwork: async () => false,
      environment: () => plan,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const chunks = [];
      const result = await operations.exec(
        "python -c 'import sys; print(sys.prefix)' && pip --version",
        workspace,
        { onData: (chunk) => chunks.push(chunk), timeout: 90 },
      );
      const output = Buffer.concat(chunks).toString("utf8");
      assert.equal(result.exitCode, 0, output);
      assert.match(output, /\/var\/pi-env\/python/);
      assert.match(output, /pip /);
    }

    const environmentMount = plan.mounts.find((mount) => mount.target === "/var/pi-env");
    assert.ok(environmentMount);
    const persistedPython = await lstat(join(environmentMount.source, "python", "bin", "python"));
    assert.equal(persistedPython.isSymbolicLink() || persistedPython.isFile(), true);
  } finally {
    await controller.stopAll(container.binary);
    await tracker.stopAll();
    await store.prune({ maxBytes: 0, retentionDays: 0 }).catch(() => undefined);
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(storeRoot, { recursive: true, force: true }),
      rm(projectRoot, { recursive: true, force: true }),
    ]);
  }
});
