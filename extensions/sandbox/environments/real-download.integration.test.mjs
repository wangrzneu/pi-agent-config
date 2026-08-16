import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
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
import { installTrustedRuntime } from "./artifact-catalog.ts";
import { resolveManagedEnvironmentPlan } from "./managed-resolver.ts";
import { prepareAppleProjectState } from "./project-state.ts";
import { EnvironmentStore } from "./store.ts";

const integrationTest = process.env.PI_SANDBOX_ENV_REAL_DOWNLOAD_INTEGRATION === "1"
  ? test
  : test.skip;

integrationTest("official pnpm package installs and executes in Apple Container", async () => {
  await ensureSandboxTempRoot();
  const workspace = await mkdtemp(join(tmpdir(), "pi-real-pnpm-workspace-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "pi-real-pnpm-store-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-real-pnpm-project-"));
  const store = new EnvironmentStore(storeRoot);
  const controller = new AppleContainerController();
  const tracker = new SandboxProcessTracker();
  const container = {
    ...DEFAULT_SANDBOX_CONFIG.isolation.appleContainer,
    image: process.env.PI_SANDBOX_TEST_IMAGE ?? DEFAULT_SANDBOX_CONFIG.isolation.appleContainer.image,
  };
  try {
    await installTrustedRuntime(store, "node", "22.14.0", "linux-arm64");
    await installTrustedRuntime(store, "pnpm", "10.6.0", "linux-arm64");
    const plan = await resolveManagedEnvironmentPlan([
      { id: "node", requestedVersion: "22.14.0" },
      { id: "pnpm", requestedVersion: "10.6.0" },
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
    const chunks = [];
    const result = await operations.exec("pnpm --version && pnpm config get store-dir", workspace, {
      onData: (chunk) => chunks.push(chunk),
      timeout: 90,
    });
    const output = Buffer.concat(chunks).toString("utf8");
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /10\.6\.0/);
    assert.match(output, /\/var\/pi-env\/pnpm-store/);
  } finally {
    await controller.stopAll(container.binary);
    await tracker.stopAll();
    await rm(workspace, { recursive: true, force: true });
    await store.prune({ maxBytes: 0, retentionDays: 0 }).catch(() => undefined);
    await rm(storeRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

integrationTest("official Node.js glibc artifact executes with the Debian bootstrap ABI", async () => {
  await ensureSandboxTempRoot();
  const workspace = await mkdtemp(join(tmpdir(), "pi-real-node-workspace-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "pi-real-node-store-"));
  const store = new EnvironmentStore(storeRoot);
  const controller = new AppleContainerController();
  const tracker = new SandboxProcessTracker();
  const container = {
    ...DEFAULT_SANDBOX_CONFIG.isolation.appleContainer,
    image: process.env.PI_SANDBOX_TEST_IMAGE ?? DEFAULT_SANDBOX_CONFIG.isolation.appleContainer.image,
  };
  try {
    await installTrustedRuntime(store, "node", "22.14.0", "linux-arm64");
    const plan = await resolveManagedEnvironmentPlan([
      { id: "node", requestedVersion: "22.14.0" },
    ], { store, platform: "linux-arm64" });
    await controller.preflight(container, workspace);
    const operations = createAppleContainerBashOperations(controller, {
      tracker,
      container,
      policy: () => ({ config: DEFAULT_SANDBOX_CONFIG, readGrants: [], writeGrants: [] }),
      gitIdentity: () => undefined,
      authorizeNetwork: async () => false,
      environment: () => plan,
    });
    const chunks = [];
    const result = await operations.exec("node --version", workspace, {
      onData: (chunk) => chunks.push(chunk),
      timeout: 90,
    });
    const output = Buffer.concat(chunks).toString("utf8");
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /v22\.14\.0/);
  } finally {
    await controller.stopAll(container.binary);
    await tracker.stopAll();
    await rm(workspace, { recursive: true, force: true });
    await store.prune({ maxBytes: 0, retentionDays: 0 }).catch(() => undefined);
    await rm(storeRoot, { recursive: true, force: true });
  }
});

integrationTest("pinned Python 3.11 and 3.12 artifacts install and execute in Apple Container", async () => {
  await ensureSandboxTempRoot();
  const workspace = await mkdtemp(join(tmpdir(), "pi-real-python-lts-workspace-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "pi-real-python-lts-store-"));
  const store = new EnvironmentStore(storeRoot);
  const controller = new AppleContainerController();
  const tracker = new SandboxProcessTracker();
  const container = {
    ...DEFAULT_SANDBOX_CONFIG.isolation.appleContainer,
    image: process.env.PI_SANDBOX_TEST_IMAGE ?? DEFAULT_SANDBOX_CONFIG.isolation.appleContainer.image,
  };
  const versions = ["3.11.11", "3.12.9"];
  await controller.preflight(container, workspace);
  try {
    for (const version of versions) {
      await installTrustedRuntime(store, "python", version, "linux-arm64");
      const plan = await resolveManagedEnvironmentPlan([
        { id: "python", requestedVersion: version },
      ], { store, platform: "linux-arm64" });
      const operations = createAppleContainerBashOperations(controller, {
        tracker,
        container,
        policy: () => ({ config: DEFAULT_SANDBOX_CONFIG, readGrants: [], writeGrants: [] }),
        gitIdentity: () => undefined,
        authorizeNetwork: async () => false,
        environment: () => plan,
      });
      const chunks = [];
      const result = await operations.exec("python --version", workspace, {
        onData: (chunk) => chunks.push(chunk),
        timeout: 90,
      });
      const output = Buffer.concat(chunks).toString("utf8");
      assert.equal(result.exitCode, 0, output);
      assert.match(output, new RegExp(`Python ${version.replaceAll(".", "\\.")}`));
    }
  } finally {
    await controller.stopAll(container.binary);
    await tracker.stopAll();
    await rm(workspace, { recursive: true, force: true });
    await store.prune({ maxBytes: 0, retentionDays: 0 }).catch(() => undefined);
    await rm(storeRoot, { recursive: true, force: true });
  }
});

integrationTest("official Go, Node.js, and kubectl artifacts install and execute where ABI-compatible", async () => {
  await ensureSandboxTempRoot();
  const workspace = await mkdtemp(join(tmpdir(), "pi-real-runtime-workspace-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "pi-real-runtime-store-"));
  const store = new EnvironmentStore(storeRoot);
  const versions = { go: "1.24.2", python: "3.13.2", node: "22.14.0", kubectl: "1.32.3" };
  const controller = new AppleContainerController();
  const tracker = new SandboxProcessTracker();
  const container = {
    ...DEFAULT_SANDBOX_CONFIG.isolation.appleContainer,
    image: process.env.PI_SANDBOX_TEST_IMAGE ?? DEFAULT_SANDBOX_CONFIG.isolation.appleContainer.image,
  };
  try {
    for (const [profile, version] of Object.entries(versions)) {
      await installTrustedRuntime(store, profile, version, "linux-arm64");
    }
    const nodeRoot = await store.resolve("linux-arm64", "node", versions.node);
    assert.ok(nodeRoot);
    await access(join(nodeRoot, "bin", "node"));

    // Go and kubectl are static Linux/arm64 binaries. Node.js installation is
    // checked here and its glibc execution has a focused integration test above.
    const plan = await resolveManagedEnvironmentPlan([
      { id: "go", requestedVersion: versions.go },
      { id: "python", requestedVersion: versions.python },
      { id: "kubectl", requestedVersion: versions.kubectl },
    ], { store, platform: "linux-arm64" });
    await controller.preflight(container, workspace);
    const operations = createAppleContainerBashOperations(controller, {
      tracker,
      container,
      policy: () => ({ config: DEFAULT_SANDBOX_CONFIG, readGrants: [], writeGrants: [] }),
      gitIdentity: () => undefined,
      authorizeNetwork: async () => false,
      environment: () => plan,
    });
    const chunks = [];
    const result = await operations.exec(
      "go version && python --version && kubectl version --client -o json",
      workspace,
      { onData: (chunk) => chunks.push(chunk), timeout: 90 },
    );
    const output = Buffer.concat(chunks).toString("utf8");
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /go version go1\.24\.2 linux\/arm64/);
    assert.match(output, /Python 3\.13\.2/);
    assert.match(output, /v1\.32\.3/);
  } finally {
    await controller.stopAll(container.binary);
    await tracker.stopAll();
    await rm(workspace, { recursive: true, force: true });
    await store.prune({ maxBytes: 0, retentionDays: 0 }).catch(() => undefined);
    await rm(storeRoot, { recursive: true, force: true });
  }
});
