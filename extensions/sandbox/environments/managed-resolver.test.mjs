import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveManagedEnvironmentPlan,
  resolveStoredEnvironments,
} from "./managed-resolver.ts";
import { EnvironmentStore } from "./store.ts";

async function publishFixture(store, id, version, digestCharacter, executable = id) {
  const staging = await store.createStagingDirectory(id);
  await mkdir(join(staging, "bin"));
  await writeFile(join(staging, "bin", executable), "#!/bin/sh\n", { mode: 0o755 });
  return store.publish({
    stagingPath: staging,
    digest: digestCharacter.repeat(64),
    platform: "linux-arm64",
    profile: id,
    version,
  });
}

test("managed resolver composes all Apple Container profiles as read-only mounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-managed-resolver-"));
  const store = new EnvironmentStore(root);
  await store.initialize();
  await publishFixture(store, "go", "1.24.2", "a");
  await publishFixture(store, "python", "3.13.2", "b", "python");
  await publishFixture(store, "node", "22.14.0", "c", "node");
  await publishFixture(store, "pnpm", "10.6.0", "d", "pnpm");
  await publishFixture(store, "kubectl", "1.32.3", "e", "kubectl");

  const plan = await resolveManagedEnvironmentPlan([
    { id: "go", requestedVersion: "1.24.2" },
    { id: "python", requestedVersion: "3.13.2" },
    { id: "node", requestedVersion: "22.14.0" },
    { id: "pnpm", requestedVersion: "10.6.0" },
    { id: "kubectl", requestedVersion: "1.32.3" },
  ], {
    store,
    platform: "linux-arm64",
  });

  assert.deepEqual(plan.profiles.map(({ id, version }) => ({ id, version })), [
    { id: "go", version: "1.24.2" },
    { id: "python", version: "3.13.2" },
    { id: "node", version: "22.14.0" },
    { id: "pnpm", version: "10.6.0" },
    { id: "kubectl", version: "1.32.3" },
  ]);
  assert.equal(plan.mounts.length, 5);
  assert.equal(plan.mounts.every((mount) => mount.readonly), true);
  assert.equal(plan.env.GOROOT, "/opt/pi-toolchains/go/1.24.2");
  assert.match(plan.env.PATH, /^\/opt\/pi-shims:\/opt\/pi-toolchains\/go\/1\.24\.2\/bin:/);
});

test("stored resolver exposes managed objects directly to the Process backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stored-resolver-"));
  const store = new EnvironmentStore(root);
  await store.initialize();
  const objectPath = await publishFixture(store, "node", "22.14.0", "f", "node");

  const profiles = await resolveStoredEnvironments([
    { id: "node", requestedVersion: "22.14.0" },
  ], { store, platform: "linux-arm64" });

  assert.deepEqual(profiles[0].binDirectories, [join(objectPath, "bin")]);
  assert.deepEqual(profiles[0].allowRead, [objectPath]);
  assert.equal(profiles[0].source, "managed");
});

test("managed resolver fails closed for unpinned or missing objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-managed-missing-"));
  const store = new EnvironmentStore(root);
  await store.initialize();
  await assert.rejects(
    resolveManagedEnvironmentPlan([{ id: "go" }], { store, platform: "linux-arm64" }),
    (error) => (
      /require an exact version: go/.test(error.message)
        && /--sandbox-env go@<version>/.test(error.message)
    ),
  );
  await assert.rejects(
    resolveManagedEnvironmentPlan([{ id: "go", requestedVersion: "1.24.2" }], { store, platform: "linux-arm64" }),
    /is not installed/,
  );
});
