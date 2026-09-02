import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveStoredEnvironments } from "./managed-resolver.ts";
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

test("stored resolver fails closed for unpinned or missing objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-managed-missing-"));
  const store = new EnvironmentStore(root);
  await store.initialize();
  await assert.rejects(
    resolveStoredEnvironments([{ id: "go" }], { store, platform: "linux-arm64" }),
    (error) => (
      /require an exact version: go/.test(error.message)
        && /--sandbox-env go@<version>/.test(error.message)
    ),
  );
  await assert.rejects(
    resolveStoredEnvironments([{ id: "go", requestedVersion: "1.24.2" }], { store, platform: "linux-arm64" }),
    /is not installed/,
  );
});

test("aws is a local-only profile and never resolves a managed object", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-managed-aws-"));
  const store = new EnvironmentStore(root);
  await store.initialize();
  await publishFixture(store, "aws", "2.31.32", "a");
  await assert.rejects(
    resolveStoredEnvironments([{ id: "aws", requestedVersion: "2.31.32" }], { store, platform: "linux-arm64" }),
    /no trusted managed runtime/,
  );
});
