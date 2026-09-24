import assert from "node:assert/strict";
import test from "node:test";
import { composeEnvironmentPlan } from "./composer.ts";

const base = {
  platform: "darwin-arm64",
  basePath: ["/opt/homebrew/bin", "/usr/bin", "/bin"],
};

test("environment plans compose PATH, variables, and read roots deterministically", () => {
  const plan = composeEnvironmentPlan(base, [
    {
      id: "go",
      version: "1.24.2",
      source: "local",
      binDirectories: ["/usr/local/go/bin"],
      env: { GOROOT: "/usr/local/go", GOENV: "off" },
      allowRead: ["/usr/local/go"],
    },
    {
      id: "python",
      version: "3.13.2",
      source: "local",
      binDirectories: ["/Users/me/project/.venv/bin"],
      env: { VIRTUAL_ENV: "/Users/me/project/.venv", PYTHONPATH: undefined },
      allowRead: ["/Users/me/project/.venv"],
    },
  ]);

  assert.equal(
    plan.env.PATH,
    "/usr/local/go/bin:/Users/me/project/.venv/bin:/opt/homebrew/bin:/usr/bin:/bin",
  );
  assert.equal(plan.env.GOROOT, "/usr/local/go");
  assert.equal(plan.env.GOENV, "off");
  assert.equal(plan.env.VIRTUAL_ENV, "/Users/me/project/.venv");
  assert.equal(plan.env.PYTHONPATH, undefined);
  assert.deepEqual(plan.allowRead, [
    "/usr/local/go",
    "/Users/me/project/.venv",
  ]);
  assert.deepEqual(plan.allowWrite, []);
});

test("writable profile roots are implicitly readable", () => {
  const plan = composeEnvironmentPlan(base, [{
    id: "go",
    version: "1.24.2",
    source: "local",
    binDirectories: ["/usr/local/go/bin"],
    env: {},
    allowRead: ["/usr/local/go"],
    allowWrite: ["/home/me/go/pkg", "/home/me/Library/Caches/go-build"],
  }]);

  assert.deepEqual(plan.allowWrite, [
    "/home/me/go/pkg",
    "/home/me/Library/Caches/go-build",
  ]);
  assert.deepEqual(plan.allowRead, [
    "/usr/local/go",
    "/home/me/go/pkg",
    "/home/me/Library/Caches/go-build",
  ]);
});

test("duplicate paths are removed without changing first-use order", () => {
  const plan = composeEnvironmentPlan(base, [{
    id: "node",
    version: "22.14.0",
    source: "local",
    binDirectories: ["/opt/homebrew/opt/node/bin", "/usr/bin", "/opt/homebrew/opt/node/bin"],
    env: {},
    allowRead: ["/opt/homebrew/opt/node", "/opt/homebrew/opt/node"],
  }]);
  assert.equal(plan.env.PATH, "/opt/homebrew/opt/node/bin:/usr/bin:/opt/homebrew/bin:/bin");
  assert.deepEqual(plan.allowRead, ["/opt/homebrew/opt/node"]);
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
