import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareAppleProjectState } from "./project-state.ts";

test("Apple project state adds a trusted Python venv bootstrap and isolated pnpm store", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "pi-project-workspace-"));
  const plan = {
    backend: "apple-container",
    platform: "linux-arm64",
    profiles: [
      {
        id: "python",
        version: "3.13.2",
        source: "managed",
        binDirectories: ["/opt/pi-toolchains/python/3.13.2/bin"],
        env: {},
        allowRead: ["/opt/pi-toolchains/python/3.13.2"],
      },
      {
        id: "pnpm",
        version: "10.6.0",
        source: "managed",
        binDirectories: ["/opt/pi-toolchains/pnpm/10.6.0/bin"],
        env: {},
        allowRead: ["/opt/pi-toolchains/pnpm/10.6.0"],
      },
    ],
    env: { PATH: "/opt/pi-toolchains/python/3.13.2/bin:/usr/bin:/bin" },
    allowRead: [],
    mounts: [],
  };

  await prepareAppleProjectState(plan, { workspace, root });

  assert.equal(plan.env.VIRTUAL_ENV, "/var/pi-env/python");
  assert.match(plan.env.PATH, /^\/var\/pi-env\/python\/bin:/);
  assert.equal(plan.env.PNPM_HOME, "/var/pi-env/pnpm-home");
  assert.equal(plan.env.npm_config_store_dir, "/var/pi-env/pnpm-store");
  assert.equal(plan.env.pnpm_config_store_dir, "/var/pi-env/pnpm-store");
  assert.deepEqual(plan.guestBootstrap, {
    pythonVenv: {
      runtime: "/opt/pi-toolchains/python/3.13.2/bin/python",
      venv: "/var/pi-env/python",
    },
  });
  assert.equal(plan.mounts.length, 1);
  assert.deepEqual(plan.mounts.map(({ target, readonly }) => ({ target, readonly })), [
    { target: "/var/pi-env", readonly: false },
  ]);
  for (const mount of plan.mounts) assert.equal((await stat(mount.source)).isDirectory(), true);
});

test("Apple plans without Python or pnpm do not receive writable project state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-state-empty-"));
  const workspace = await mkdtemp(join(tmpdir(), "pi-project-workspace-empty-"));
  const plan = {
    backend: "apple-container",
    platform: "linux-arm64",
    profiles: [],
    env: { PATH: "/usr/bin:/bin" },
    allowRead: [],
    mounts: [],
  };
  await prepareAppleProjectState(plan, { workspace, root });
  assert.deepEqual(plan.mounts, []);
  assert.equal(plan.guestBootstrap, undefined);
});
