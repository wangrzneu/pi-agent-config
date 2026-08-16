import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultPiReadRoots,
  registerSandboxExtension,
  resolveAppleContainerHostGateway,
  resolveSandboxBackendMode,
} from "./index.ts";
import { EnvironmentStore } from "./environments/store.ts";
import { KubernetesContextSelectionStore } from "./kubernetes/context-selection-store.ts";

function createHarness(runtime, flags = {}, authorizationOptions) {
  const effectiveFlags = { "sandbox-mode": "process", ...flags };
  const handlers = new Map();
  const commands = new Map();
  let bashTool;
  let authorizationTool;
  let writeAuthorizationTool;
  const statuses = new Map();
  const notifications = [];
  const confirmations = [];
  const pi = {
    registerFlag() {},
    getFlag(name) {
      return effectiveFlags[name] ?? false;
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
      async confirm(title, message) {
        confirmations.push({ title, message });
        return true;
      },
      setStatus(key, value) {
        statuses.set(key, value);
      },
    },
  };

  const kubernetesSelectionStore = new KubernetesContextSelectionStore(
    join(tmpdir(), `pi-index-test-kube-selections-${randomUUID()}`),
  );
  registerSandboxExtension(
    pi,
    runtime,
    {
      environmentStore: new EnvironmentStore(join(tmpdir(), `pi-index-test-store-${randomUUID()}`)),
      projectStateRoot: join(tmpdir(), `pi-index-test-projects-${randomUUID()}`),
      kubernetesSelectionStore,
      ...(authorizationOptions ?? { allowOsTemp: false }),
    },
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
    confirmations,
    kubernetesSelectionStore,
  };
}

function createAppleController({ preflightError } = {}) {
  let preflights = 0;
  return {
    async preflight() {
      preflights += 1;
      if (preflightError) throw preflightError;
    },
    track() {},
    release() {},
    async forceDelete() {},
    async stopAll() {},
    preflightCount() {
      return preflights;
    },
  };
}

function createRuntime({ initializeError } = {}) {
  let resets = 0;
  let networkAsk;
  const commandConfigs = [];
  return {
    runtime: {
      isSupportedPlatform() {
        return true;
      },
      async initialize(_config, ask) {
        if (initializeError) throw initializeError;
        networkAsk = ask;
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
    askNetwork(params) {
      assert.ok(networkAsk, "network authorization callback was registered");
      return networkAsk(params);
    },
  };
}

test("Apple Container gateway prefers the authoritative container CLI, then the bridge heuristic", async () => {
  const address = (value) => ({ address: value, family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: `${value}/24`, mac: "00:00:00:00:00:00" });

  assert.equal(await resolveAppleContainerHostGateway({
    containerBinary: "/usr/bin/container",
    run: async () => JSON.stringify([{ status: { ipv4Gateway: "192.168.64.1" } }]),
  }), "192.168.64.1");

  assert.equal(await resolveAppleContainerHostGateway({
    interfaces: {
      bridge0: [address("192.168.1.1")],
      bridge100: [address("192.168.65.1")],
    },
  }), "192.168.65.1");
  await assert.rejects(
    resolveAppleContainerHostGateway({ interfaces: {} }),
    /unique private Apple Container host gateway/,
  );
});

test("sandbox backend mode resolves CLI overrides", () => {
  assert.equal(resolveSandboxBackendMode(undefined, "auto"), "auto");
  assert.equal(resolveSandboxBackendMode(undefined, "process"), "process");
  assert.equal(resolveSandboxBackendMode("process", "auto"), "process");
  assert.equal(resolveSandboxBackendMode("apple-container", "process"), "apple-container");
  assert.throws(() => resolveSandboxBackendMode("vm", "auto"), /Invalid --sandbox-mode/);
  assert.throws(() => resolveSandboxBackendMode(undefined, "vm"), /Invalid isolation\.mode/);
});

test("auto mode selects Apple Container when prerequisites pass", async () => {
  const fake = createRuntime();
  const controller = createAppleController();
  const harness = createHarness(
    fake.runtime,
    { "sandbox-mode": "auto" },
    { allowOsTemp: false, appleContainerController: controller },
  );
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.equal(controller.preflightCount(), 1);
  assert.ok(harness.notifications.some(({ message }) => /Apple Container \+ Process sandbox initialized/.test(message)));
  await harness.commands.get("sandbox")("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /Requested backend: auto/);
  assert.match(harness.notifications.at(-1).message, /Effective backend: apple-container/);
});

test("auto mode reports missing prerequisites and falls back to Process sandbox", async () => {
  const fake = createRuntime();
  const controller = createAppleController({
    preflightError: new Error("container system status timed out after 12000ms"),
  });
  const harness = createHarness(
    fake.runtime,
    { "sandbox-mode": "auto" },
    { allowOsTemp: false, appleContainerController: controller },
  );
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.match(harness.statuses.get("sandbox"), /sandbox on/);
  assert.ok(harness.notifications.some(({ message, level }) => (
    level === "warning"
      && /timed out after 12000ms/.test(message)
      && /Falling back to the Process sandbox/.test(message)
  )));
  await harness.commands.get("sandbox")("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /Effective backend: process/);
});

test("forced Apple Container mode fails closed when prerequisites are missing", async () => {
  const fake = createRuntime();
  const controller = createAppleController({ preflightError: new Error("guest image is missing") });
  const harness = createHarness(
    fake.runtime,
    { "sandbox-mode": "apple-container" },
    { allowOsTemp: false, appleContainerController: controller },
  );
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.match(harness.statuses.get("sandbox"), /sandbox blocked/);
  assert.equal(fake.resetCount(), 1);
  assert.ok(harness.notifications.some(({ message }) => /guest image is missing/.test(message)));
});

test("auto mode resolves unpinned environments locally without an Apple fallback warning", async () => {
  const fake = createRuntime();
  const controller = createAppleController();
  const harness = createHarness(
    fake.runtime,
    { "sandbox-mode": "auto", "sandbox-env": "go" },
    {
      allowOsTemp: false,
      appleContainerController: controller,
      async environmentResolver(requested) {
        return requested.map(({ id }) => ({
          id,
          version: "1.24.2",
          source: "local",
          binDirectories: ["/managed/go/bin"],
          env: { GOROOT: "/managed/go", GOENV: "off" },
          allowRead: ["/managed/go"],
        }));
      },
    },
  );
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.equal(controller.preflightCount(), 0, "Apple must not be attempted for unpinned runtimes");
  assert.ok(!harness.notifications.some(({ message }) => /managed Apple environment unavailable/.test(message)));
  assert.ok(harness.notifications.some(({ message, level }) => (
    level === "info"
      && /Using the Process sandbox instead of Apple Container because go has no pinned version/.test(message)
      && /--sandbox-env go@<version>/.test(message)
  )));
  assert.match(harness.statuses.get("sandbox"), /sandbox on/);
  await harness.commands.get("sandbox")("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /Effective backend: process/);
  assert.match(harness.notifications.at(-1).message, /go: 1\.24\.2 \(local/);
});

test("forced Apple Container mode fails closed with a clear message for unpinned runtimes", async () => {
  const fake = createRuntime();
  const harness = createHarness(
    fake.runtime,
    { "sandbox-mode": "apple-container", "sandbox-env": "go,python" },
    { allowOsTemp: false, appleContainerController: createAppleController() },
  );
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.match(harness.statuses.get("sandbox"), /sandbox blocked/);
  assert.ok(harness.notifications.some(({ message }) => (
    /require an exact version: go, python/.test(message)
      && /--sandbox-env go@<version>/.test(message)
  )));
  const error = harness.notifications.find(({ level }) => level === "error");
  assert.ok(error, "expected an error notification");
  assert.doesNotMatch(error.message, /\.\./);
});

test("unlisted network domains request approval once per session", async () => {
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  const confirmations = [];
  harness.ctx.ui.confirm = async (title, message) => {
    confirmations.push({ title, message });
    return true;
  };
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.equal(await fake.askNetwork({ host: "Downloads.Example.COM.", port: 443 }), true);
  assert.equal(await fake.askNetwork({ host: "downloads.example.com", port: 8443 }), true);
  assert.equal(confirmations.length, 1, "an approved exact domain is remembered across ports");
  assert.match(confirmations[0].title, /network access/i);
  assert.match(confirmations[0].message, /downloads\.example\.com:443/);
  assert.match(confirmations[0].message, /rest of this session/);

  await harness.commands.get("sandbox")("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /Session domain grants: downloads\.example\.com/);

  await harness.commands.get("sandbox")("revoke-network", harness.ctx);
  assert.equal(await fake.askNetwork({ host: "downloads.example.com", port: 443 }), true);
  assert.equal(confirmations.length, 2, "revoking network grants causes the next access to prompt");
});

test("unlisted network domains are denied without an interactive approval channel", async () => {
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  harness.ctx.hasUI = false;
  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.equal(await fake.askNetwork({ host: "blocked.example.com", port: 443 }), false);
});

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

test("selected Process development environments inject env and exact read roots", async () => {
  const fake = createRuntime();
  const resolvedRequests = [];
  const harness = createHarness(
    fake.runtime,
    { "sandbox-env": "go@1.24.2,python@3.13.2" },
    {
      allowOsTemp: false,
      async environmentResolver(requested) {
        resolvedRequests.push(requested);
        return requested.map(({ id }) => id === "go" ? {
          id: "go",
          version: "1.24.2",
          source: "local",
          binDirectories: ["/managed/go/bin"],
          env: { GOROOT: "/managed/go", GOENV: "off" },
          allowRead: ["/managed/go"],
        } : {
          id: "python",
          version: "3.13.2",
          source: "local",
          binDirectories: ["/managed/python/bin"],
          env: { VIRTUAL_ENV: "/managed/python" },
          allowRead: ["/managed/python"],
        });
      },
    },
  );
  await harness.handlers.get("session_start")({}, harness.ctx);

  const result = await harness.bashTool.execute(
    "call-env",
    { command: "printf '%s|%s|%s' \"$GOROOT\" \"$VIRTUAL_ENV\" \"$PATH\"" },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.equal(resolvedRequests.length, 2);
  assert.equal(result.content[0].text.startsWith("/managed/go|/managed/python|/managed/go/bin:/managed/python/bin:"), true);
  const commandConfig = fake.commandConfigs().at(-1);
  assert.ok(commandConfig.filesystem.allowRead.includes("/managed/go"));
  assert.ok(commandConfig.filesystem.allowRead.includes("/managed/python"));
  await harness.commands.get("sandbox")("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /go: 1\.24\.2 \(local/);
  assert.match(harness.notifications.at(-1).message, /python: 3\.13\.2 \(local/);
});

test("TUI startup selector supplies the environment request when no CLI flag is present", async () => {
  const fake = createRuntime();
  let selectorCalls = 0;
  const harness = createHarness(fake.runtime, {}, {
    allowOsTemp: false,
    async environmentSelector() {
      selectorCalls += 1;
      return "go@1.24.2";
    },
    async environmentResolver() {
      return [{
        id: "go",
        version: "1.24.2",
        source: "local",
        binDirectories: ["/managed/go/bin"],
        env: { GOROOT: "/managed/go" },
        allowRead: ["/managed/go"],
      }];
    },
  });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  assert.equal(selectorCalls, 1);
  await harness.commands.get("sandbox")("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /go: 1\.24\.2/);
});

test("forced Apple Container installs missing exact managed runtimes after approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-managed-install-"));
  const store = new EnvironmentStore(root);
  let installs = 0;
  const fake = createRuntime();
  const harness = createHarness(fake.runtime, {
    "sandbox-mode": "apple-container",
    "sandbox-env": "go@1.24.2",
  }, {
    allowOsTemp: false,
    appleContainerController: createAppleController(),
    environmentStore: store,
    async runtimeInstaller(targetStore, profile, version, platform) {
      installs += 1;
      const stagingPath = await targetStore.createStagingDirectory(profile);
      await mkdir(join(stagingPath, "bin"), { recursive: true });
      await writeFile(join(stagingPath, "bin", profile), "#!/bin/sh\n", { mode: 0o755 });
      return targetStore.publish({
        stagingPath,
        digest: "7".repeat(64),
        platform,
        profile,
        version,
      });
    },
  });
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  assert.equal(installs, 1);
  await harness.commands.get("sandbox")("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /backend: apple-container/);
  assert.match(harness.notifications.at(-1).message, /go: 1\.24\.2/);
});

test("forced Apple Container accepts a managed guest environment plan", async () => {
  const fake = createRuntime();
  const controller = createAppleController();
  const harness = createHarness(
    fake.runtime,
    { "sandbox-mode": "apple-container", "sandbox-env": "go@1.24.2" },
    {
      allowOsTemp: false,
      appleContainerController: controller,
      async managedEnvironmentResolver() {
        return {
          backend: "apple-container",
          platform: "linux-arm64",
          profiles: [{
            id: "go",
            version: "1.24.2",
            source: "managed",
            binDirectories: ["/opt/pi-toolchains/go/1.24.2/bin"],
            env: { PATH: "/opt/pi-toolchains/go/1.24.2/bin:/usr/bin:/bin" },
            allowRead: ["/opt/pi-toolchains/go/1.24.2"],
          }],
          env: { PATH: "/opt/pi-toolchains/go/1.24.2/bin:/usr/bin:/bin" },
          allowRead: ["/opt/pi-toolchains/go/1.24.2"],
          mounts: [{
            source: "/host/go/1.24.2",
            target: "/opt/pi-toolchains/go/1.24.2",
            readonly: true,
          }],
        };
      },
    },
  );
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.match(harness.statuses.get("sandbox"), /sandbox on/);
  assert.equal(controller.preflightCount(), 1);
  await harness.commands.get("sandbox")("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /go: 1\.24\.2 \(managed, linux-arm64\)/);
});

test("forced Apple Container fails closed when a managed environment is missing", async () => {
  const fake = createRuntime();
  const harness = createHarness(
    fake.runtime,
    { "sandbox-mode": "apple-container", "sandbox-env": "go@1.24.2" },
    {
      allowOsTemp: false,
      async managedEnvironmentResolver() {
        throw new Error("go@1.24.2 for linux-arm64 is not installed");
      },
    },
  );
  await harness.handlers.get("session_start")({}, harness.ctx);
  assert.match(harness.statuses.get("sandbox"), /sandbox blocked/);
  assert.ok(harness.notifications.some(({ message }) => /is not installed/.test(message)));
});

test("Kubernetes startup selection and /sandbox kube select inject a revocable sanitized config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-kube-command-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "kubectl"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "sandbox.json"), JSON.stringify({
    kubernetes: { persistContextSelection: true },
  }));
  const kubeconfigPath = join(root, "sanitized-config.json");
  const grants = [];
  const fakeAccess = {
    kubeconfigPath,
    async grant(request) { grants.push(request); },
    async revoke(context) {
      const index = grants.findIndex((grant) => grant.metadata.name === context);
      if (index >= 0) grants.splice(index, 1);
    },
    async revokeAll() { grants.length = 0; },
    list() {
      return grants.map((grant) => ({
        context: grant.metadata.name,
        cluster: grant.metadata.cluster,
        namespace: grant.metadata.namespace,
        access: grant.access,
        namespaces: grant.namespaces,
        authentication: grant.metadata.authentication,
      }));
    },
    async stop() {},
  };
  const fake = createRuntime();
  const harness = createHarness(fake.runtime, { "sandbox-env": "kubectl" }, {
    allowOsTemp: false,
    async environmentResolver() {
      return [{
        id: "kubectl",
        version: "1.32.3",
        source: "local",
        binDirectories: [bin],
        env: {},
        allowRead: [root],
      }];
    },
    async kubernetesContextDiscovery() {
      return {
        currentContext: "dev-admin",
        contexts: [{
          name: "dev-admin",
          cluster: "dev",
          server: "https://dev.example.com",
          user: "dev-user",
          namespace: "team-a",
          authentication: "exec",
          execCommand: "aws",
          execArgs: ["eks", "get-token", "--cluster-name", "dev"],
          execEnvironmentNames: ["AWS_PROFILE"],
        }],
      };
    },
    async kubernetesAccessFactory() { return fakeAccess; },
  });
  harness.ctx.cwd = root;
  harness.ctx.ui.select = async () => "dev-admin";
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

  assert.equal(grants.length, 1, JSON.stringify(harness.notifications));
  assert.deepEqual(await harness.kubernetesSelectionStore.load(root), ["dev-admin"]);
  assert.equal(grants[0].access, "observe");
  assert.match(
    harness.confirmations.at(-1).message,
    /"aws" "eks" "get-token" "--cluster-name" "dev".*AWS_PROFILE/s,
  );
  assert.deepEqual(grants[0].namespaces, ["team-a"]);
  const result = await harness.bashTool.execute(
    "kube-env",
    { command: "printf %s \"$KUBECONFIG\"" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(result.content[0].text, kubeconfigPath);
  assert.ok(
    fake.commandConfigs().at(-1).filesystem.denyWrite.includes(kubeconfigPath),
    "sanitized kubeconfig is read-only to Process sandbox commands",
  );

  await harness.commands.get("sandbox")("kube revoke dev-admin", harness.ctx);
  assert.equal(grants.length, 0);
  await harness.commands.get("sandbox")("kube select dev-admin", harness.ctx);
  assert.equal(grants.length, 1);
  await harness.commands.get("sandbox")("kube forget", harness.ctx);
  assert.deepEqual(await harness.kubernetesSelectionStore.load(root), []);
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

test("defaultPiReadRoots includes ~/.agents/skills when it exists", () => {
  const fakeHome = join(tmpdir(), `pi-agents-home-${process.pid}-${Date.now()}`);
  const skills = join(fakeHome, ".agents", "skills");
  assert.equal(defaultPiReadRoots(fakeHome).some((root) => root === skills), false,
    "missing ~/.agents/skills is not added",
  );
  mkdirSync(skills, { recursive: true });
  const roots = defaultPiReadRoots(fakeHome);
  assert.ok(roots.includes(skills), "existing ~/.agents/skills is readable by default");
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

test("remote git and gh operations without approval are rejected instead of failing in the sandbox", async () => {
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  harness.ctx.cwd = process.cwd();
  harness.ctx.ui.confirm = async () => false;
  await harness.handlers.get("session_start")({}, harness.ctx);

  for (const command of [
    "git push --dry-run origin main",
    "git pull origin main",
    "git fetch origin",
    "gh pr create",
    "gh repo create my-repo --public",
    "gh api user",
  ]) {
    await assert.rejects(
      harness.bashTool.execute(
        "host-escape-call",
        { command },
        undefined,
        undefined,
        harness.ctx,
      ),
      /not approved/,
    );
  }
});

test("host execution approval is remembered per command word for the session", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-sandbox-hostmem-"));
  await mkdir(join(project, ".pi"), { recursive: true });
  // Use a harmless command word as the configurable host-exec prefix, so the
  // promoted host execution is deterministic and safe in a unit test.
  await writeFile(join(project, ".pi", "sandbox.json"), JSON.stringify({
    hostExec: { commands: ["echo"] },
  }));
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  harness.ctx.cwd = project;
  let confirmCalls = 0;
  harness.ctx.ui.confirm = async () => {
    confirmCalls += 1;
    return true;
  };
  await harness.handlers.get("session_start")({}, harness.ctx);

  const first = await harness.bashTool.execute(
    "host-mem-1",
    { command: "echo first" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(confirmCalls, 1, "first occurrence prompts once");
  assert.match(first.content[0].text, /first/);

  const second = await harness.bashTool.execute(
    "host-mem-2",
    { command: "echo second" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(confirmCalls, 1, "same word does not re-prompt");
  assert.match(second.content[0].text, /second/);
});

test("host execution memory is keyed per command word, not global", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-sandbox-hostword-"));
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "sandbox.json"), JSON.stringify({
    hostExec: { commands: ["echo", "printf"] },
  }));
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  harness.ctx.cwd = project;
  let confirmCalls = 0;
  harness.ctx.ui.confirm = async () => {
    confirmCalls += 1;
    return true;
  };
  await harness.handlers.get("session_start")({}, harness.ctx);

  await harness.bashTool.execute(
    "host-word-1",
    { command: "echo one" },
    undefined,
    undefined,
    harness.ctx,
  );
  await harness.bashTool.execute(
    "host-word-2",
    { command: "echo two" },
    undefined,
    undefined,
    harness.ctx,
  );
  // A different configured word still prompts even though echo was approved.
  await harness.bashTool.execute(
    "host-word-3",
    { command: "printf three" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(confirmCalls, 2, "echo approved once, printf still prompts");
});

test("configurable host-exec prefix runs on the host after approval", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-sandbox-hostprefix-"));
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "sandbox.json"), JSON.stringify({
    hostExec: { commands: ["echo"] },
  }));
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  harness.ctx.cwd = project;
  harness.ctx.ui.confirm = async () => true;
  await harness.handlers.get("session_start")({}, harness.ctx);

  const result = await harness.bashTool.execute(
    "host-prefix",
    { command: "echo routed-to-host" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.match(result.content[0].text, /routed-to-host/);
});

test("host execution requires a TUI approval channel for a new word", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-sandbox-hostnoxui-"));
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "sandbox.json"), JSON.stringify({
    hostExec: { commands: ["echo"] },
  }));
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  harness.ctx.cwd = project;
  harness.ctx.hasUI = false;
  harness.ctx.mode = "stdio";
  await harness.handlers.get("session_start")({}, harness.ctx);

  await assert.rejects(
    harness.bashTool.execute(
      "host-noui",
      { command: "echo hi" },
      undefined,
      undefined,
      harness.ctx,
    ),
    /echo operations require interactive approval/,
  );
});

test("/sandbox env status, list, and prune expose safe store management", async () => {
  const fake = createRuntime();
  const harness = createHarness(fake.runtime);
  await harness.handlers.get("session_start")({}, harness.ctx);

  await harness.commands.get("sandbox")("env status", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /Environment store.*Objects: 0/s);
  await harness.commands.get("sandbox")("env list", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /Installed:\n    \(none\)/);
  await harness.commands.get("sandbox")("env prune --all", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /pruned 0 inactive object/);
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
