import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SANDBOX_CONFIG } from "../config.ts";
import { resolveProcessEnvironmentPlan } from "./process-resolver.ts";
import { EnvironmentStore } from "./store.ts";

test("Process resolution falls back per profile to exact managed host objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-process-managed-fallback-"));
  const store = new EnvironmentStore(root);
  let approvals = 0;
  let installs = 0;
  const plan = await resolveProcessEnvironmentPlan([
    { id: "go", requestedVersion: "1.24.2" },
    { id: "node", requestedVersion: "22.14.0" },
  ], {
    cwd: "/project",
    env: { PATH: "/host/bin" },
    platform: "linux-arm64",
    store,
    config: DEFAULT_SANDBOX_CONFIG.developmentEnvironments,
    async localResolver(requested) {
      if (requested[0].id === "node") throw new Error("local version mismatch");
      return [{
        id: "go",
        version: "1.24.2",
        source: "local",
        binDirectories: ["/host/go/bin"],
        env: { GOROOT: "/host/go", GOENV: "off" },
        allowRead: ["/host/go"],
      }];
    },
    async approveInstall(requested) {
      approvals += 1;
      assert.deepEqual(requested.map(({ id }) => id), ["node"]);
      return true;
    },
    async installer(targetStore, profile, version, platform) {
      installs += 1;
      const stagingPath = await targetStore.createStagingDirectory(profile);
      await mkdir(join(stagingPath, "bin"), { recursive: true });
      await writeFile(join(stagingPath, "bin", profile), "#!/bin/sh\n", { mode: 0o755 });
      return targetStore.publish({
        stagingPath,
        digest: "8".repeat(64),
        platform,
        profile,
        version,
      });
    },
  });

  assert.equal(approvals, 1);
  assert.equal(installs, 1);
  assert.deepEqual(plan.profiles.map(({ id, source }) => ({ id, source })), [
    { id: "go", source: "local" },
    { id: "node", source: "managed" },
  ]);
  assert.match(plan.env.PATH, /^\/host\/go\/bin:.*toolchains\/objects\/sha256\/8{64}\/bin:/);
});

test("local source fails instead of silently installing a managed object", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-process-local-only-"));
  const config = structuredClone(DEFAULT_SANDBOX_CONFIG.developmentEnvironments);
  config.profiles.node.source = "local";
  await assert.rejects(resolveProcessEnvironmentPlan([
    { id: "node", requestedVersion: "22.14.0" },
  ], {
    cwd: "/project",
    env: { PATH: "" },
    platform: "linux-arm64",
    store: new EnvironmentStore(root),
    config,
    async localResolver() { throw new Error("node missing"); },
  }), /node missing/);
});
