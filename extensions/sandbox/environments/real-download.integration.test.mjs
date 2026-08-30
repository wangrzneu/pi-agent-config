import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { installTrustedRuntime } from "./artifact-catalog.ts";
import { resolveStoredEnvironments } from "./managed-resolver.ts";
import { EnvironmentStore } from "./store.ts";

const execFileAsync = promisify(execFile);
const platform = `${process.platform}-${process.arch}`;
const integrationTest = process.env.PI_SANDBOX_ENV_REAL_DOWNLOAD_INTEGRATION === "1"
  ? test
  : test.skip;

async function run(executable, args) {
  const { stdout, stderr } = await execFileAsync(executable, args, {
    timeout: 30_000,
    env: process.env,
  });
  return `${stdout}${stderr}`;
}

integrationTest("official artifacts install and execute on the host platform", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "pi-real-runtime-store-"));
  const store = new EnvironmentStore(storeRoot);
  const versions = { go: "1.26.6", python: "3.13.9", node: "26.5.0", kubectl: "1.32.3" };
  try {
    for (const [profile, version] of Object.entries(versions)) {
      await installTrustedRuntime(store, profile, version, platform);
    }
    const profiles = await resolveStoredEnvironments([
      { id: "go", requestedVersion: versions.go },
      { id: "python", requestedVersion: versions.python },
      { id: "node", requestedVersion: versions.node },
      { id: "kubectl", requestedVersion: versions.kubectl },
    ], { store, platform });
    const executable = (id) => join(
      profiles.find((profile) => profile.id === id).binDirectories[0],
      id,
    );
    await access(executable("node"));
    assert.match(await run(executable("go"), ["version"]), /go version go1\.26\.6/);
    assert.match(await run(executable("python"), ["--version"]), /Python 3\.13\.9/);
    assert.match(await run(executable("node"), ["--version"]), /v26\.5\.0/);
    assert.match(await run(executable("kubectl"), ["version", "--client", "--output=json"]), /v1\.32\.3/);
  } finally {
    await store.prune({ maxBytes: 0, retentionDays: 0 }).catch(() => undefined);
    await rm(storeRoot, { recursive: true, force: true });
  }
});
