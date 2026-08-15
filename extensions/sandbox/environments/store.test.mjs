import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EnvironmentStore, parseEnvironmentStoreSize } from "./store.ts";

const DIGEST = "a".repeat(64);

test("environment store sizes parse deterministic binary units", () => {
  assert.equal(parseEnvironmentStoreSize("512mb"), 512 * 1024 ** 2);
  assert.equal(parseEnvironmentStoreSize("5g"), 5 * 1024 ** 3);
  assert.throws(() => parseEnvironmentStoreSize("unlimited"), /Invalid environment-store size/);
});

test("environment store publishes immutable objects and resolves version references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-env-store-"));
  const store = new EnvironmentStore(root);
  await store.initialize();
  const staging = await store.createStagingDirectory("go");
  await mkdir(join(staging, "bin"));
  await writeFile(join(staging, "bin", "go"), "runtime");

  const objectPath = await store.publish({
    stagingPath: staging,
    digest: DIGEST,
    platform: "linux-arm64",
    profile: "go",
    version: "1.24.2",
  });

  assert.equal(await readFile(join(objectPath, "bin", "go"), "utf8"), "runtime");
  await assert.rejects(writeFile(join(objectPath, "bin", "go"), "mutated"), /EACCES|EPERM/);
  assert.equal(await store.resolve("linux-arm64", "go", "1.24.2"), objectPath);
  assert.equal((await stat(objectPath)).isDirectory(), true);
});

test("publishing an existing digest reuses the object and discards duplicate staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-env-store-duplicate-"));
  const store = new EnvironmentStore(root);
  await store.initialize();

  const first = await store.createStagingDirectory("node");
  await writeFile(join(first, "marker"), "first");
  const objectPath = await store.publish({
    stagingPath: first,
    digest: DIGEST,
    platform: "linux-arm64",
    profile: "node",
    version: "22.14.0",
  });

  const duplicate = await store.createStagingDirectory("node");
  await writeFile(join(duplicate, "marker"), "duplicate");
  const reused = await store.publish({
    stagingPath: duplicate,
    digest: DIGEST,
    platform: "linux-arm64",
    profile: "node",
    version: "22.14.1",
  });

  assert.equal(reused, objectPath);
  assert.equal(await readFile(join(reused, "marker"), "utf8"), "first");
  assert.equal(await store.resolve("linux-arm64", "node", "22.14.1"), objectPath);
});

test("leases protect active objects while quota pruning removes least-recently-used runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-env-store-prune-"));
  const store = new EnvironmentStore(root);
  await store.initialize();
  for (const [profile, version, digest] of [
    ["go", "1.24.2", "b".repeat(64)],
    ["node", "22.14.0", "c".repeat(64)],
  ]) {
    const staging = await store.createStagingDirectory(profile);
    await mkdir(join(staging, "bin"));
    await writeFile(join(staging, "bin", profile), Buffer.alloc(32, profile));
    await store.publish({ stagingPath: staging, digest, platform: "linux-arm64", profile, version });
  }

  await store.acquireLease("session-one", "linux-arm64", "go", "1.24.2");
  const status = await store.status();
  assert.equal(status.objects, 2);
  assert.equal(status.installed.length, 2);
  assert.equal(status.leasedObjects, 1);
  assert.equal(status.installed.find((entry) => entry.profile === "go").leased, true);
  const first = await store.prune({ maxBytes: 0, retentionDays: 3650 });
  assert.deepEqual(first.removedDigests, ["c".repeat(64)]);
  assert.ok(await store.resolve("linux-arm64", "go", "1.24.2"));
  assert.equal(await store.resolve("linux-arm64", "node", "22.14.0"), undefined);

  await store.releaseLease("session-one");
  const second = await store.prune({ maxBytes: 0, retentionDays: 3650 });
  assert.deepEqual(second.removedDigests, ["b".repeat(64)]);
});

test("environment store rejects traversal in every externally supplied segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-env-store-invalid-"));
  const store = new EnvironmentStore(root);
  await store.initialize();
  await assert.rejects(store.resolve("../darwin", "go", "1.24.2"), /Invalid platform/);
  await assert.rejects(store.resolve("linux-arm64", "../go", "1.24.2"), /Invalid profile/);
  await assert.rejects(store.resolve("linux-arm64", "go", "../../tmp"), /Invalid version/);

  const staging = await store.createStagingDirectory("go");
  await assert.rejects(store.publish({
    stagingPath: staging,
    digest: "not-a-digest",
    platform: "linux-arm64",
    profile: "go",
    version: "1.24.2",
  }), /Invalid SHA-256 digest/);
});
