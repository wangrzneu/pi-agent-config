#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const decisions = new Map();
let nextRequestId = 1;
let initialized = false;
let activeChild;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(error) {
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

function finish(code) {
  input.close();
  process.stdout.write("", () => process.exit(code));
}

async function authorizeNetwork({ host, port }) {
  const requestId = String(nextRequestId++);
  send({ type: "networkRequest", requestId, host, port });
  return new Promise((resolve) => decisions.set(requestId, resolve));
}

async function execute(request) {
  if (initialized) throw new Error("guest runner accepts one command per container");
  initialized = true;
  if (!request || request.type !== "execute") throw new Error("expected execute request");

  const safeEnvironment = {};
  for (const [name, value] of Object.entries(request.env ?? {})) {
    if (typeof value === "string") safeEnvironment[name] = value;
  }
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, safeEnvironment);
  process.chdir(request.cwd);

  await SandboxManager.initialize(request.policy, authorizeNetwork);
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    request.command,
    request.shell ?? "/bin/bash",
    undefined,
    undefined,
    request.cwd,
  );
  send({ type: "ready" });

  activeChild = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: request.cwd,
    env: { ...safeEnvironment, ...wrapped.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChild.stdout.on("data", (chunk) => send({ type: "stdout", data: chunk.toString("base64") }));
  activeChild.stderr.on("data", (chunk) => send({ type: "stderr", data: chunk.toString("base64") }));
  const exitCode = await new Promise((resolve, reject) => {
    activeChild.once("error", reject);
    activeChild.once("close", resolve);
  });
  SandboxManager.cleanupAfterCommand();
  await SandboxManager.reset();
  send({ type: "exit", exitCode });
  finish(typeof exitCode === "number" ? exitCode : 1);
}

input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(new Error("invalid guest protocol JSON"));
    return;
  }

  if (message.type === "networkDecision") {
    const resolve = decisions.get(String(message.requestId));
    if (resolve) {
      decisions.delete(String(message.requestId));
      resolve(message.allowed === true);
    }
    return;
  }
  if (message.type === "cancel") {
    activeChild?.kill("SIGTERM");
    return;
  }
  execute(message).catch(async (error) => {
    fail(error);
    await SandboxManager.reset().catch(() => undefined);
    finish(1);
  });
});

input.once("close", () => {
  if (!initialized) {
    fail(new Error("guest protocol closed before execute request"));
    process.exitCode = 1;
  }
});
