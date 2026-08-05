import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerSandboxExtension } from "./index.ts";

function createHarness(runtime, flags = {}, authorizationOptions) {
  const handlers = new Map();
  const commands = new Map();
  let bashTool;
  let authorizationTool;
  let writeAuthorizationTool;
  const statuses = new Map();
  const notifications = [];
  const pi = {
    registerFlag() {},
    getFlag(name) {
      return flags[name] ?? false;
    },
    registerTool(tool) {
      if (tool.name === "bash") bashTool = tool;
      if (tool.name === "sandbox_authorize_read") authorizationTool = tool;
      if (tool.name === "sandbox_authorize_write") writeAuthorizationTool = tool;
    },
    registerCommand(name, definition) {
      commands.set(name, definition.handler);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    model: undefined,
    thinkingLevel: undefined,
    isProjectTrusted() {
      return true;
    },
    sessionManager: {
      getSessionId() {
        return "sandbox-test-session";
      },
      getSessionFile() {
        return undefined;
      },
    },
    ui: {
      theme: {
        fg(_color, value) {
          return value;
        },
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
      async confirm() {
        return true;
      },
      setStatus(key, value) {
        statuses.set(key, value);
      },
    },
  };

  registerSandboxExtension(
    pi,
    runtime,
    authorizationOptions ?? { allowOsTemp: false },
  );
  return {
    handlers,
    commands,
    bashTool,
    authorizationTool,
    writeAuthorizationTool,
    ctx,
    statuses,
    notifications,
  };
}

function createRuntime({ initializeError } = {}) {
  let resets = 0;
  const commandConfigs = [];
  return {
    runtime: {
      isSupportedPlatform() {
        return true;
      },
      async initialize() {
        if (initializeError) throw initializeError;
      },
      async wrapWithSandbox(command, _shell, config) {
        commandConfigs.push(config);
        return command;
      },
      cleanupAfterCommand() {},
      async reset() {
        resets += 1;
      },
    },
    resetCount() {
      return resets;
    },
    commandConfigs() {
      return commandConfigs;
    },
  };
}

test("initialized sandbox executes bash with Pi session environment", async () => {
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  await harness.handlers.get("session_start")({}, harness.ctx);

  const result = await harness.bashTool.execute(
    "call-1",
    { command: "printf %s \"$PI_SESSION_ID\"" },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.equal(result.content[0].text, "sandbox-test-session");
  assert.match(harness.statuses.get("sandbox"), /sandbox on/);

  await harness.handlers.get("session_shutdown")({}, harness.ctx);
  assert.equal(fake.resetCount(), 1);
});

test("OS temp paths are readable from outside the workspace by default", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-ostemp-"));
  const externalFile = join(externalRoot, "outside.txt");
  await writeFile(externalFile, "transient");
  const fake = createRuntime();
  // Production default: allowOsTemp stays true — no override passed here.
  const harness = createHarness(fake.runtime, {}, {});
  await harness.handlers.get("session_start")({}, harness.ctx);

  const gate = await harness.handlers.get("tool_call")({
    toolName: "read",
    input: { path: externalFile },
  }, harness.ctx);
  assert.equal(gate, undefined, "OS temp read should pass the gate by default");
});

test("Pi managed skill files are readable without a grant", async () => {
  const piRoot = await mkdtemp(join(tmpdir(), "pi-agent-resources-"));
  const skillsDir = join(piRoot, "git", "github.com", "demo", "skills", "pi-workflow");
  await mkdir(skillsDir, { recursive: true });
  const skillFile = join(skillsDir, "SKILL.md");
  await writeFile(skillFile, "guidance");
  const fake = createRuntime();
  const harness = createHarness(fake.runtime, {}, {
    allowOsTemp: false,
    piReadRoots: [join(piRoot, "git")],
  });
  await harness.handlers.get("session_start")({}, harness.ctx);

  const gate = await harness.handlers.get("tool_call")({
    toolName: "read",
    input: { path: skillFile },
  }, harness.ctx);
  assert.equal(gate, undefined, "Pi skill file read should pass the gate");
});

test("external reads are blocked until the user grants the path", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-external-"));
  const externalFile = join(externalRoot, "outside.txt");
  await writeFile(externalFile, "approved content");
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  await harness.handlers.get("session_start")({}, harness.ctx);

  const blocked = await harness.handlers.get("tool_call")({
    toolName: "read",
    input: { path: externalFile },
  }, harness.ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /requires authorization/);

  harness.ctx.ui.confirm = async () => false;
  await assert.rejects(
    harness.authorizationTool.execute(
      "authorize-denied",
      { paths: [externalRoot], reason: "Inspect a fixture" },
      undefined,
      undefined,
      harness.ctx,
    ),
    /was not approved/,
  );
  harness.ctx.ui.confirm = async () => true;

  const authorizationResult = await harness.authorizationTool.execute(
    "authorize-1",
    { paths: [externalRoot], reason: "Inspect a fixture" },
    undefined,
    undefined,
    harness.ctx,
  );

  const allowed = await harness.handlers.get("tool_call")({
    toolName: "read",
    input: { path: externalFile },
  }, harness.ctx);
  assert.equal(allowed, undefined);
  const writeStillBlocked = await harness.handlers.get("tool_call")({
    toolName: "write",
    input: { path: externalFile },
  }, harness.ctx);
  assert.equal(writeStillBlocked.block, true);

  const result = await harness.bashTool.execute(
    "call-external",
    { command: `cat ${JSON.stringify(externalFile)}` },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(result.content[0].text, "approved content");
  assert.ok(
    fake.commandConfigs().at(-1).filesystem.allowRead.includes(
      authorizationResult.details.paths[0],
    ),
  );
});

test("external writes are blocked until the user grants the target", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-write-"));
  const externalFile = join(externalRoot, "created.txt");
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  await harness.handlers.get("session_start")({}, harness.ctx);

  const blocked = await harness.handlers.get("tool_call")({
    toolName: "write",
    input: { path: externalFile },
  }, harness.ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Writing outside the workspace requires authorization/);

  const authorizationResult = await harness.writeAuthorizationTool.execute(
    "authorize-write",
    { paths: [externalFile], reason: "Create an external fixture" },
    undefined,
    undefined,
    harness.ctx,
  );

  const allowed = await harness.handlers.get("tool_call")({
    toolName: "write",
    input: { path: externalFile },
  }, harness.ctx);
  assert.equal(allowed, undefined);
  const readStillBlocked = await harness.handlers.get("tool_call")({
    toolName: "read",
    input: { path: externalFile },
  }, harness.ctx);
  assert.equal(readStillBlocked.block, true);

  await harness.bashTool.execute(
    "call-write-external",
    { command: `printf created > ${JSON.stringify(externalFile)}` },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(await readFile(externalFile, "utf8"), "created");
  assert.ok(
    fake.commandConfigs().at(-1).filesystem.allowWrite.includes(
      authorizationResult.details.paths[0],
    ),
  );
});

test("sandbox initialization failure blocks bash instead of falling back", async () => {
  const fake = createRuntime({ initializeError: new Error("missing dependency") });
  const harness = createHarness(fake.runtime);
  await harness.handlers.get("session_start")({}, harness.ctx);

  await assert.rejects(
    harness.bashTool.execute(
      "call-2",
      { command: "printf unsafe" },
      undefined,
      undefined,
      harness.ctx,
    ),
    /Sandboxed bash is unavailable: initialization failed: missing dependency/,
  );
  assert.match(harness.statuses.get("sandbox"), /sandbox blocked/);
  assert.equal(fake.resetCount(), 1);
});

test("--no-sandbox bypasses both the OS sandbox and the direct-tool gate", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-bypass-"));
  const externalFile = join(externalRoot, "outside.txt");
  await writeFile(externalFile, "outside");
  const fake = createRuntime();
  const harness = createHarness(fake.runtime, { "no-sandbox": true });
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.match(harness.statuses.get("sandbox"), /sandbox off/);
  const gate = await harness.handlers.get("tool_call")({
    toolName: "read",
    input: { path: externalFile },
  }, harness.ctx);
  assert.equal(gate, undefined);
  assert.equal(fake.resetCount(), 0);

  const result = await harness.bashTool.execute(
    "call-bypass",
    { command: "printf %s \"$PI_SESSION_ID\"" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(result.content[0].text, "sandbox-test-session");
});

test("enabled:false in project config bypasses the sandbox", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-sandbox-disabled-"));
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "sandbox.json"), JSON.stringify({ enabled: false }));
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  harness.ctx.cwd = project;
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.match(harness.statuses.get("sandbox"), /sandbox off/);
  assert.ok(harness.notifications.some(({ message }) => /disabled by configuration/.test(message)));
  assert.equal(fake.resetCount(), 0);
});

test("unsupported platform blocks bash and is reported", async () => {
  const fake = createRuntime();
  fake.runtime.isSupportedPlatform = () => false;
  const harness = createHarness(fake.runtime);
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.match(harness.statuses.get("sandbox"), /sandbox blocked/);
  await assert.rejects(
    harness.bashTool.execute(
      "call-platform",
      { command: "printf x" },
      undefined,
      undefined,
      harness.ctx,
    ),
    /Sandboxed bash is unavailable/,
  );
});

test("find, ls, and grep reads outside the workspace are gated", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-search-"));
  const externalFile = join(externalRoot, "outside.txt");
  await writeFile(externalFile, "outside");
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  await harness.handlers.get("session_start")({}, harness.ctx);

  for (const tool of ["find", "ls", "grep"]) {
    const blocked = await harness.handlers.get("tool_call")({
      toolName: tool,
      input: { path: externalFile },
    }, harness.ctx);
    assert.equal(blocked.block, true, tool);
    assert.match(blocked.reason, /Reading outside the workspace requires authorization/);
  }
});

test("remote git operations without approval are rejected instead of failing in the sandbox", async () => {
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  harness.ctx.cwd = process.cwd();
  harness.ctx.ui.confirm = async () => false;
  await harness.handlers.get("session_start")({}, harness.ctx);

  for (const command of [
    "git push --dry-run origin main",
    "git pull origin main",
    "git fetch origin",
  ]) {
    await assert.rejects(
      harness.bashTool.execute(
        "remote-git-call",
        { command },
        undefined,
        undefined,
        harness.ctx,
      ),
      /Remote git operation was not approved/,
    );
  }
});

test("/sandbox allow-read grants a path for the session", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-command-"));
  const externalFile = join(externalRoot, "outside.txt");
  await writeFile(externalFile, "authorized");
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  await harness.handlers.get("session_start")({}, harness.ctx);

  await harness.commands.get("sandbox")(`allow-read ${externalRoot}`, harness.ctx);

  const allowed = await harness.handlers.get("tool_call")({
    toolName: "read",
    input: { path: externalFile },
  }, harness.ctx);
  assert.equal(allowed, undefined);
});

test("session shutdown on quit removes the sandbox temp root", async () => {
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  await harness.handlers.get("session_start")({}, harness.ctx);

  const { SANDBOX_TEMP_ROOT } = await import("./sandbox-paths.ts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(SANDBOX_TEMP_ROOT, "tmp"), { recursive: true });

  await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);

  const { stat } = await import("node:fs/promises");
  await assert.rejects(stat(SANDBOX_TEMP_ROOT), /ENOENT/);
});
