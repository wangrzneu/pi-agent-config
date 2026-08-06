import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SANDBOX_CONFIG,
  loadSandboxConfig,
  mergeSandboxConfig,
} from "./config.ts";
import { SANDBOX_TEMP_ROOT } from "./sandbox-paths.ts";

test("default shell reads deny the filesystem root and allow the workspace back", () => {
  assert.deepEqual(DEFAULT_SANDBOX_CONFIG.filesystem.denyRead, ["/"]);
  assert.ok(DEFAULT_SANDBOX_CONFIG.filesystem.allowRead.includes("."));
  assert.equal(DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite[0], ".");
  assert.ok(DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite.includes(SANDBOX_TEMP_ROOT));
  assert.equal(DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite.includes(homedir()), false);
  assert.ok(DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite.includes(tmpdir()));
});

test("sandbox config replaces arrays while preserving unspecified defaults", () => {
  const config = mergeSandboxConfig(DEFAULT_SANDBOX_CONFIG, {
    network: { allowedDomains: ["internal.example.com"] },
    filesystem: { allowWrite: ["."] },
  });

  assert.deepEqual(config.network.allowedDomains, ["internal.example.com"]);
  assert.equal(config.network.allowLocalBinding, true);
  assert.deepEqual(config.filesystem.allowWrite, ["."]);
  assert.deepEqual(config.filesystem.denyRead, DEFAULT_SANDBOX_CONFIG.filesystem.denyRead);
  assert.equal(config.enableWeakerNetworkIsolation, true);
  assert.notEqual(config.network, DEFAULT_SANDBOX_CONFIG.network);
});

test("runtime passthrough options can be overridden by configuration", () => {
  const config = mergeSandboxConfig(DEFAULT_SANDBOX_CONFIG, {
    enableWeakerNetworkIsolation: false,
  });
  assert.equal(config.enableWeakerNetworkIsolation, false);
});

test("trusted project config takes precedence over global config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "sandbox.json"),
    JSON.stringify({ network: { allowedDomains: ["global.example.com"] } }),
  );
  await writeFile(
    join(cwd, ".pi", "sandbox.json"),
    JSON.stringify({ network: { allowedDomains: ["project.example.com"] } }),
  );

  const loaded = loadSandboxConfig(cwd, agentDir, ".pi", true);

  assert.deepEqual(loaded.config.network.allowedDomains, ["project.example.com"]);
  assert.equal(loaded.loadedFrom.length, 2);
  assert.deepEqual(loaded.warnings, []);
});

test("hostExec defaults to the credential-needing CLI list", () => {
  const commands = DEFAULT_SANDBOX_CONFIG.hostExec?.commands ?? [];
  assert.ok(commands.includes("aws"));
  assert.ok(commands.includes("gcloud"));
  assert.ok(commands.includes("az"));
  assert.ok(commands.includes("gh") === false); // gh is a built-in detector
});

test("hostExec default excludes sandbox-friendly and high-privilege commands", () => {
  const commands = DEFAULT_SANDBOX_CONFIG.hostExec?.commands ?? [];
  // Package managers work sandboxed via cache redirection + allowedDomains.
  assert.equal(commands.includes("npm"), false);
  assert.equal(commands.includes("pnpm"), false);
  assert.equal(commands.includes("yarn"), false);
  // High-privilege escapes stay opt-in.
  assert.equal(commands.includes("ssh"), false);
  assert.equal(commands.includes("docker"), false);
});

test("hostExec overrides replace the command list wholesale", () => {
  const config = mergeSandboxConfig(DEFAULT_SANDBOX_CONFIG, { hostExec: { commands: ["az"] } });
  assert.deepEqual(config.hostExec?.commands, ["az"]);
});

test("untrusted project config is ignored and reported", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-untrusted-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "sandbox.json"), JSON.stringify({ enabled: false }));

  const loaded = loadSandboxConfig(cwd, agentDir, ".pi", false);

  assert.equal(loaded.config.enabled, true);
  assert.equal(loaded.loadedFrom.length, 0);
  assert.match(loaded.warnings[0], /Ignored untrusted project configuration/);
});
