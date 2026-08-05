import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONNECTION_POLICY } from "./authorization.ts";
import {
  registerSshToolsExtension,
  SshSession,
} from "./index.ts";

const HOST = "staging";

/**
 * Minimal ExtensionAPI fake. It records registered tools, commands, and event
 * handlers and exposes an active-tool list for SshToolActivation.
 */
function fakePi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  let activeTools = [];
  return {
    tools,
    commands,
    handlers,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(next) {
      activeTools = [...next];
    },
  };
}

function fakeCtx(confirm = async () => true) {
  const notifications = [];
  return {
    hasUI: true,
    mode: "tui",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    ui: {
      confirm,
      notify: (message) => { notifications.push(message); },
      custom: async () => undefined,
      setStatus: () => undefined,
      theme: { fg: () => "" },
    },
    notifications,
  };
}

function installedSession() {
  const session = new SshSession();
  session.authorization.grant(HOST, ["exec", "jobs"], DEFAULT_CONNECTION_POLICY);
  return session;
}

async function sshEnable(pi, ctx) {
  const tool = pi.tools.get("ssh_enable");
  return tool.execute(
    "ssh-enable-call",
    { host: HOST, capabilities: ["exec", "jobs"] },
    undefined,
    undefined,
    ctx,
  );
}

test("capability grants survive agent turns and are silent on re-enable", async () => {
  const pi = fakePi();
  const session = installedSession();
  registerSshToolsExtension(pi, session);
  const ctx = fakeCtx();

  // First enable within the session requires no confirmation: the grants were
  // already seeded, so `authorize` short-circuits before any network or UI.
  await sshEnable(pi, ctx);
  assert.equal(typeof ctx.ui.confirm, "function");

  // Simulate the agent finishing its turn. The settled handler must not revoke
  // capability grants (session-scoped), only settle tool visibility.
  const settled = pi.handlers.get("agent_settled");
  assert.ok(settled, "agent_settled handler must be registered");
  await settled({}, ctx);

  // Re-enabling the same host/capabilities after a settle is silent.
  await sshEnable(pi, ctx);
  assert.equal(
    session.authorization.missingCapabilities(HOST, ["exec", "jobs"]).length,
    0,
    "grants must survive agent_settled",
  );
});

test("/ssh-tools off revokes capability grants", async () => {
  const pi = fakePi();
  const session = installedSession();
  registerSshToolsExtension(pi, session);
  const ctx = fakeCtx();

  const command = pi.commands.get("ssh-tools");
  assert.ok(command, "ssh-tools command must be registered");
  await command.handler("off", ctx);

  assert.equal(
    session.authorization.missingCapabilities(HOST, ["exec", "jobs"]).length,
    2,
    "off must revoke all capability grants",
  );
});

test("/ssh-tools off does not disrupt the login-environment grant; reset clears it", async () => {
  const pi = fakePi();
  const session = installedSession();
  session.authorizeLoginEnvironment(HOST);
  registerSshToolsExtension(pi, session);
  const ctx = fakeCtx();

  const command = pi.commands.get("ssh-tools");
  await command.handler("off", ctx);
  assert.equal(
    session.isLoginEnvironmentAuthorized(HOST),
    true,
    "login-environment grant is session-scoped and survives off",
  );

  await command.handler("reset", ctx);
  assert.equal(
    session.isLoginEnvironmentAuthorized(HOST),
    false,
    "reset clears the login-environment grant",
  );
  assert.equal(session.authorization.getHosts().length, 0, "reset clears all authorization");
});
