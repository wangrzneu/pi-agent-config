import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalEnvironments } from "./local-resolver.ts";

function createProbe() {
  const executables = new Map([
    ["go", "/tools/go/bin/go"],
    ["python3", "/project/.venv/bin/python"],
    ["node", "/tools/node/bin/node"],
    ["pnpm", "/tools/pnpm/bin/pnpm"],
    ["kubectl", "/tools/kubectl/bin/kubectl"],
  ]);
  const outputs = new Map([
    ["/tools/go/bin/go\0env\0-json\0GOROOT\0GOVERSION", JSON.stringify({ GOROOT: "/tools/go", GOVERSION: "go1.24.2" })],
    ["/project/.venv/bin/python\0-I\0-S\0-c\0probe", JSON.stringify({ executable: "/project/.venv/bin/python", prefix: "/project/.venv", basePrefix: "/tools/python", version: "3.13.2" })],
    ["/tools/node/bin/node\0--version", "v22.14.0\n"],
    ["/tools/pnpm/bin/pnpm\0--version", "10.6.0\n"],
    ["/tools/kubectl/bin/kubectl\0version\0--client\0-o\0json", JSON.stringify({ clientVersion: { gitVersion: "v1.32.3" } })],
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
];

test("local resolver produces composable profiles without sourcing a shell", async () => {
  const profiles = await resolveLocalEnvironments(requested, {
    cwd: "/project",
    env: { PATH: "/tools/bin", VIRTUAL_ENV: "/project/.venv" },
    probe: createProbe(),
  });

  assert.deepEqual(profiles.map(({ id, version }) => ({ id, version })), [
    { id: "go", version: "1.24.2" },
    { id: "python", version: "3.13.2" },
    { id: "node", version: "22.14.0" },
    { id: "pnpm", version: "10.6.0" },
    { id: "kubectl", version: "1.32.3" },
  ]);
  assert.deepEqual(profiles[0].env, { GOROOT: "/tools/go", GOENV: "off" });
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
    /requested 20\.0\.0, but the local runtime is 22\.14\.0/,
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
