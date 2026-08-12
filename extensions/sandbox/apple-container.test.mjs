import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildContainerRunArgs,
  compileGuestPolicy,
  validateAppleContainerConfig,
} from "./apple-container.ts";
import { DEFAULT_SANDBOX_CONFIG, mergeSandboxConfig } from "./config.ts";
import {
  createTransactionalWorkspace,
  discardTransactionalWorkspace,
  isWorkspaceChangeAllowed,
  reconcileTransactionalWorkspace,
} from "./transactional-workspace.ts";

const containerConfig = DEFAULT_SANDBOX_CONFIG.isolation.appleContainer;

test("Apple Container isolation is opt-in and merges without replacing defaults", () => {
  assert.equal(containerConfig.enabled, false);
  const merged = mergeSandboxConfig(DEFAULT_SANDBOX_CONFIG, {
    isolation: { appleContainer: { enabled: true, memory: "4g" } },
  });
  assert.equal(merged.isolation.appleContainer.enabled, true);
  assert.equal(merged.isolation.appleContainer.memory, "4g");
  assert.equal(merged.isolation.appleContainer.image, containerConfig.image);
  assert.equal(merged.isolation.appleContainer.workspaceMode, "transactional-apfs");
});

test("strict Apple Container configuration rejects policy-weakening modes", () => {
  assert.throws(
    () => validateAppleContainerConfig({ ...containerConfig, enabled: true, pullPolicy: "missing" }),
    /pullPolicy must be 'never'/,
  );
  assert.throws(
    () => validateAppleContainerConfig({ ...containerConfig, enabled: true, workspaceMode: "direct" }),
    /transactional-apfs/,
  );
});

test("container launch plan is ephemeral, root-read-only, and uses bind mounts instead of volumes", () => {
  const args = buildContainerRunArgs({
    config: containerConfig,
    name: "pi-sbx-test",
    workspaceSource: "/tmp/pi-stage/workspace",
    workspaceTarget: "/Users/test/project",
    readMounts: ["/Users/test/reference"],
  });
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--tmpfs"));
  assert.equal(args.includes("--volume"), false, "Apple anonymous/named volumes would leak disk space");
  assert.ok(args.includes("type=bind,source=/tmp/pi-stage/workspace,target=/Users/test/project"));
  assert.ok(args.includes("type=bind,source=/Users/test/reference,target=/Users/test/reference,readonly"));
});

test("guest Process policy preserves network rules and compiles Linux filesystem roots", () => {
  const policy = compileGuestPolicy(DEFAULT_SANDBOX_CONFIG, "/workspace", ["/reference"]);
  assert.deepEqual(policy.network.allowedDomains, DEFAULT_SANDBOX_CONFIG.network.allowedDomains);
  assert.deepEqual(policy.filesystem.denyRead, ["/"]);
  assert.ok(policy.filesystem.allowRead.includes("/workspace"));
  assert.ok(policy.filesystem.allowRead.includes("/reference"));
  assert.ok(policy.filesystem.allowRead.includes("/usr"));
  assert.ok(policy.filesystem.allowWrite.includes("/workspace"));
  assert.equal(policy.enableWeakerNestedSandbox, false);
});

test("workspace policy blocks configured and mandatory protected paths", () => {
  const policy = { allowWrite: ["."], denyWrite: [".env", "*.pem"] };
  assert.equal(isWorkspaceChangeAllowed("src/index.ts", "/workspace", policy), true);
  assert.equal(isWorkspaceChangeAllowed("nested/.env", "/workspace", policy), false);
  assert.equal(isWorkspaceChangeAllowed("certs/dev.pem", "/workspace", policy), false);
  assert.equal(isWorkspaceChangeAllowed(".git/hooks/pre-commit", "/workspace", policy), false);
  assert.equal(isWorkspaceChangeAllowed(".git/objects/ab/cd", "/workspace", policy), true);
});

test("transactional workspace commits allowed changes", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-container-txn-test-"));
  const workspace = join(root, "project");
  const transactions = join(root, "transactions");
  await mkdir(workspace);
  await writeFile(join(workspace, "existing.txt"), "before");
  const transaction = await createTransactionalWorkspace(workspace, transactions);
  try {
    await writeFile(join(transaction.staged, "existing.txt"), "after");
    await writeFile(join(transaction.staged, "new.txt"), "new");
    const changes = await reconcileTransactionalWorkspace(transaction, {
      allowWrite: ["."],
      denyWrite: [".env"],
    });
    assert.deepEqual(changes.map((change) => change.path).sort(), ["existing.txt", "new.txt"]);
    assert.equal(await readFile(join(workspace, "existing.txt"), "utf8"), "after");
    assert.equal(await readFile(join(workspace, "new.txt"), "utf8"), "new");
  } finally {
    await discardTransactionalWorkspace(transaction);
    await rm(root, { recursive: true, force: true });
  }
});

test("transactional workspace rejects the entire batch when one path is protected", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-container-txn-deny-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  await writeFile(join(workspace, "existing.txt"), "before");
  const transaction = await createTransactionalWorkspace(workspace, join(root, "transactions"));
  try {
    await writeFile(join(transaction.staged, "existing.txt"), "after");
    await writeFile(join(transaction.staged, ".env"), "secret");
    await assert.rejects(
      reconcileTransactionalWorkspace(transaction, { allowWrite: ["."], denyWrite: [".env"] }),
      /protected path/,
    );
    assert.equal(await readFile(join(workspace, "existing.txt"), "utf8"), "before");
    await assert.rejects(readFile(join(workspace, ".env")), /ENOENT/);
  } finally {
    await discardTransactionalWorkspace(transaction);
    await rm(root, { recursive: true, force: true });
  }
});
