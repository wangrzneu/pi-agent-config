import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveLocalEnvironments } from "./local-resolver.ts";

function createProbe() {
  const executables = new Map([
    ["go", "/tools/go/bin/go"],
    ["python3", "/project/.venv/bin/python"],
    ["node", "/tools/node/bin/node"],
    ["pnpm", "/tools/pnpm/bin/pnpm"],
    ["kubectl", "/tools/kubectl/bin/kubectl"],
    ["aws", "/tools/awscli/bin/aws"],
  ]);
  const outputs = new Map([
    ["/tools/go/bin/go\0env\0-json\0GOROOT\0GOVERSION", JSON.stringify({ GOROOT: "/tools/go", GOVERSION: "go1.24.2" })],
    ["/project/.venv/bin/python\0-I\0-S\0-c\0probe", JSON.stringify({ executable: "/project/.venv/bin/python", prefix: "/project/.venv", basePrefix: "/tools/python", version: "3.13.2" })],
    ["/tools/node/bin/node\0--version", "v22.14.0\n"],
    ["/tools/pnpm/bin/pnpm\0--version", "10.6.0\n"],
    ["/tools/kubectl/bin/kubectl\0version\0--client\0-o\0json", JSON.stringify({ clientVersion: { gitVersion: "v1.32.3" } })],
    ["/tools/awscli/bin/aws\0--version", "aws-cli/2.31.32 Python/3.13.7 Darwin/25.5.0 source/arm64\n"],
  ]);
  return {
    async findExecutable(command) {
      return executables.get(command);
    },
    async isExecutable(path) {
      return path === "/project/.venv/bin/python";
    },
    async canonicalize(path) {
      return path;
    },
    async run(file, args) {
      const normalizedArgs = args[0] === "-I" ? ["-I", "-S", "-c", "probe"] : args;
      const key = [file, ...normalizedArgs].join("\0");
      const output = outputs.get(key);
      if (output === undefined) throw new Error(`unexpected probe: ${key}`);
      return output;
    },
  };
}

const requested = [
  { id: "go", requestedVersion: "1.24.2" },
  { id: "python", requestedVersion: "3.13.2" },
  { id: "node", requestedVersion: "22.14.0" },
  { id: "pnpm", requestedVersion: "10.6.0" },
  { id: "kubectl", requestedVersion: "1.32.3" },
  { id: "aws", requestedVersion: "2.31.32" },
];

test("local resolver produces composable profiles without sourcing a shell", async () => {
  const home = realpathSync(await mkdtemp(join(tmpdir(), "pi-local-go-")));
  const moduleCache = join(home, "go", "pkg", "mod");
  const buildCache = process.platform === "darwin"
    ? join(home, "Library", "Caches", "go-build")
    : join(home, ".cache", "go-build");
  const profiles = await resolveLocalEnvironments(requested, {
    cwd: "/project",
    env: { PATH: "/tools/bin", HOME: home, VIRTUAL_ENV: "/project/.venv" },
    probe: createProbe(),
  });

  assert.deepEqual(profiles.map(({ id, version }) => ({ id, version })), [
    { id: "go", version: "1.24.2" },
    { id: "python", version: "3.13.2" },
    { id: "node", version: "22.14.0" },
    { id: "pnpm", version: "10.6.0" },
    { id: "kubectl", version: "1.32.3" },
    { id: "aws", version: "2.31.32" },
  ]);
  assert.deepEqual(profiles[0].env, {
    GOROOT: "/tools/go",
    GOENV: "off",
    GOMODCACHE: moduleCache,
    GOCACHE: buildCache,
  });
  assert.deepEqual(profiles[0].allowRead, ["/tools/go", moduleCache, buildCache]);
  assert.deepEqual(profiles[0].allowWrite, [moduleCache, buildCache]);
  assert.deepEqual(profiles[1].env, {
    VIRTUAL_ENV: "/project/.venv",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: undefined,
    PYTHONHOME: undefined,
  });
  assert.ok(profiles[2].binDirectories.includes("/tools/node/bin"));
});

test("requested version mismatches fail closed", async () => {
  await assert.rejects(
    resolveLocalEnvironments([{ id: "node", requestedVersion: "20.0.0" }], {
      cwd: "/project",
      env: { PATH: "/tools/bin" },
      probe: createProbe(),
    }),
    /requested 20\.0\.0, but the local runtime is 22\.14\.0; a matching managed runtime is required/,
  );
});

test("pinned aws version mismatches do not promise a managed runtime", async () => {
  await assert.rejects(
    resolveLocalEnvironments([{ id: "aws", requestedVersion: "2.99.99" }], {
      cwd: "/project",
      env: { PATH: "/tools/bin" },
      probe: createProbe(),
    }),
    /requested 2\.99\.99, but the local runtime is 2\.31\.32; the profile resolves local runtimes only/,
  );
});

test("PATH entries inside the workspace are never executed by the trusted resolver", async () => {
  let runs = 0;
  const probe = {
    async findExecutable() { return "/project/node_modules/.bin/node"; },
    async isExecutable() { return true; },
    async canonicalize(path) { return path; },
    async run() { runs += 1; return "v22.14.0"; },
  };
  await assert.rejects(resolveLocalEnvironments([{ id: "node" }], {
    cwd: "/project",
    env: { PATH: "/project/node_modules/.bin" },
    probe,
  }), /inside the workspace/);
  assert.equal(runs, 0);
});

test("missing local tools fail with the selected profile name", async () => {
  const probe = createProbe();
  probe.findExecutable = async () => undefined;
  await assert.rejects(
    resolveLocalEnvironments([{ id: "kubectl" }], {
      cwd: "/project",
      env: { PATH: "/bin" },
      probe,
    }),
    /kubectl executable was not found/,
  );
});

test("aws --version output without an aws-cli version fails closed", async () => {
  const probe = createProbe();
  probe.run = async () => "AWS CLI command not found";
  await assert.rejects(
    resolveLocalEnvironments([{ id: "aws" }], {
      cwd: "/project",
      env: { PATH: "/tools/bin" },
      probe,
    }),
    /did not report an aws-cli version/,
  );
});
