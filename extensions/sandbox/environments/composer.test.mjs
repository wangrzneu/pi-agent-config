import assert from "node:assert/strict";
import test from "node:test";
import { composeEnvironmentPlan } from "./composer.ts";

const base = {
  backend: "apple-container",
  platform: "linux-arm64",
  basePath: ["/usr/bin", "/bin"],
  shimDirectory: "/opt/pi-shims",
};

test("environment plans compose PATH, variables, and read roots deterministically", () => {
  const plan = composeEnvironmentPlan(base, [
    {
      id: "go",
      version: "1.24.2",
      source: "managed",
      binDirectories: ["/opt/pi-toolchains/go/1.24.2/bin"],
      env: { GOROOT: "/opt/pi-toolchains/go/1.24.2", GOENV: "off" },
      allowRead: ["/opt/pi-toolchains/go/1.24.2"],
    },
    {
      id: "python",
      version: "3.13.2",
      source: "managed",
      binDirectories: ["/var/pi-env/python/bin", "/opt/pi-toolchains/python/3.13.2/bin"],
      env: { VIRTUAL_ENV: "/var/pi-env/python", PYTHONPATH: undefined },
      allowRead: ["/opt/pi-toolchains/python/3.13.2"],
    },
  ]);

  assert.equal(
    plan.env.PATH,
    "/opt/pi-shims:/opt/pi-toolchains/go/1.24.2/bin:/var/pi-env/python/bin:/opt/pi-toolchains/python/3.13.2/bin:/usr/bin:/bin",
  );
  assert.equal(plan.env.GOROOT, "/opt/pi-toolchains/go/1.24.2");
  assert.equal(plan.env.GOENV, "off");
  assert.equal(plan.env.VIRTUAL_ENV, "/var/pi-env/python");
  assert.equal(plan.env.PYTHONPATH, undefined);
  assert.deepEqual(plan.allowRead, [
    "/opt/pi-toolchains/go/1.24.2",
    "/opt/pi-toolchains/python/3.13.2",
  ]);
});

test("duplicate paths are removed without changing first-use order", () => {
  const plan = composeEnvironmentPlan(base, [{
    id: "node",
    version: "22.14.0",
    source: "managed",
    binDirectories: ["/opt/node/bin", "/usr/bin", "/opt/node/bin"],
    env: {},
    allowRead: ["/opt/node", "/opt/node"],
  }]);
  assert.equal(plan.env.PATH, "/opt/pi-shims:/opt/node/bin:/usr/bin:/bin");
  assert.deepEqual(plan.allowRead, ["/opt/node"]);
});

test("profile variable conflicts and direct PATH overrides fail closed", () => {
  assert.throws(() => composeEnvironmentPlan(base, [{
    id: "node",
    version: "22.14.0",
    source: "managed",
    binDirectories: [],
    env: { PATH: "/untrusted" },
    allowRead: [],
  }]), /must use binDirectories/);

  assert.throws(() => composeEnvironmentPlan(base, [
    {
      id: "go",
      version: "1",
      source: "managed",
      binDirectories: [],
      env: { SHARED: "go" },
      allowRead: [],
    },
    {
      id: "python",
      version: "1",
      source: "managed",
      binDirectories: [],
      env: { SHARED: "python" },
      allowRead: [],
    },
  ]), /Conflicting environment variable SHARED/);
});
