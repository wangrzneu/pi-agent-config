import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  AppleContainerController,
  createAppleContainerBashOperations,
} from "./apple-container.ts";
import { DEFAULT_SANDBOX_CONFIG } from "./config.ts";
import { SandboxProcessTracker } from "./process.ts";
import { ensureSandboxTempRoot, SANDBOX_TEMP_ROOT } from "./sandbox-paths.ts";

const enabled = process.env.PI_APPLE_CONTAINER_INTEGRATION === "1";
const integrationTest = enabled ? test : test.skip;

integrationTest("Apple Container + host/guest Process sandboxes enforce end-to-end policy", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apple-container-integration-"));
  const controller = new AppleContainerController();
  const tracker = new SandboxProcessTracker();
  const proxy = await startHostForwardProxy();
  const config = structuredClone(DEFAULT_SANDBOX_CONFIG);
  config.isolation.appleContainer.enabled = true;
  config.network.allowedDomains = ["github.com"];
  config.network.deniedDomains = ["example.com"];
  config.network.strictAllowlist = true;
  config.network.parentProxy = {
    http: `http://192.168.65.1:${proxy.port}`,
    https: `http://192.168.65.1:${proxy.port}`,
  };
  config.filesystem.allowRead = [workspace, SANDBOX_TEMP_ROOT, "/System", "/usr", "/bin", "/sbin", "/Library", "/opt/homebrew", "/private/etc", "/etc", "/dev", "/var", "/private/var", "/tmp", "/private/tmp"];
  config.filesystem.allowWrite = [".", workspace, SANDBOX_TEMP_ROOT, tmpdir(), "/tmp", "/private/tmp"];
  const { enabled: _enabled, isolation: _isolation, hostExec: _hostExec, ...runtimeConfig } = config;

  await ensureSandboxTempRoot();
  await writeFile(join(workspace, "existing.txt"), "before");
  const hiddenHostFile = join(workspace, "..", "host-only-secret.txt");
  await writeFile(hiddenHostFile, "must-not-be-mounted");
  await SandboxManager.initialize(runtimeConfig);
  await controller.preflight(config.isolation.appleContainer);

  const operations = createAppleContainerBashOperations(controller, {
    tracker,
    container: config.isolation.appleContainer,
    policy: () => ({ config, readGrants: [], writeGrants: [] }),
    gitIdentity: () => ({ name: "Pi Integration", email: "pi-integration@example.invalid" }),
    authorizeNetwork: async () => false,
  });

  const run = async (command, timeout = 120) => {
    const chunks = [];
    const result = await operations.exec(command, workspace, {
      onData: (chunk) => chunks.push(chunk),
      timeout,
      env: {
        PATH: process.env.PATH,
        SRT_DEBUG: process.env.SRT_DEBUG,
        OPENAI_API_KEY: "integration-secret",
      },
    });
    return { result, output: Buffer.concat(chunks).toString("utf8") };
  };

  try {
    const basic = await run("printf 'guest=%s bwrap=%s' \"$(uname -s)\" \"$(command -v bwrap)\"");
    assert.equal(basic.result.exitCode, 0, basic.output);
    assert.match(basic.output, /guest=Linux/);
    assert.match(basic.output, /bwrap=\/usr\/bin\/bwrap/);

    const isolation = await run(`
      test -z \"\${OPENAI_API_KEY+x}\" || exit 31
      test ! -e ${JSON.stringify(hiddenHostFile)} || exit 32
      touch /usr/pi-rootfs-must-be-read-only 2>/dev/null && exit 33
      printf isolation-ok
    `);
    assert.equal(isolation.result.exitCode, 0, isolation.output);
    assert.match(isolation.output, /isolation-ok/);

    const write = await run("printf after > existing.txt; mkdir -p src; printf created > src/new.txt");
    assert.equal(write.result.exitCode, 0, write.output);
    assert.equal(await readFile(join(workspace, "existing.txt"), "utf8"), "after");
    assert.equal(await readFile(join(workspace, "src", "new.txt"), "utf8"), "created");

    const protectedWrite = await run("printf protected > .env");
    assert.notEqual(protectedWrite.result.exitCode, 0);
    assert.match(protectedWrite.output, /Operation not permitted|Permission denied/);
    assert.equal(await readFile(join(workspace, "existing.txt"), "utf8"), "after");
    await assert.rejects(readFile(join(workspace, ".env")), /ENOENT/);

    const allowedNetwork = await run("curl -fsS -o /dev/null --max-time 30 https://github.com && printf network-ok", 180);
    assert.equal(allowedNetwork.result.exitCode, 0, allowedNetwork.output);
    assert.match(allowedNetwork.output, /network-ok/);

    const deniedNetwork = await run("curl -fsS --max-time 10 https://example.com", 120);
    assert.notEqual(deniedNetwork.result.exitCode, 0);

    await assert.rejects(run("sleep 30", 0.2), /timeout:0.2/);

    const listed = await waitForManagedContainersToDisappear(config.isolation.appleContainer.binary);
    assert.equal(
      listed.some((item) => String(item.configuration?.id ?? "").startsWith("pi-sbx-")),
      false,
      "ephemeral integration containers must be removed",
    );
  } finally {
    await controller.stopAll(config.isolation.appleContainer.binary);
    await tracker.stopAll();
    await SandboxManager.reset().catch(() => undefined);
    await proxy.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(join(workspace, "..", "host-only-secret.txt"), { force: true });
    await rm(SANDBOX_TEMP_ROOT, { recursive: true, force: true });
  }
});

async function startHostForwardProxy() {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const target = new URL(request.url ?? "http://invalid.invalid/");
    if (target.hostname === "github.com") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("network-ok");
      return;
    }
    response.writeHead(502);
    response.end();
  });
  server.on("connect", (request, client, head) => {
    const target = request.url ?? "";
    const separator = target.lastIndexOf(":");
    const host = target.slice(0, separator);
    const port = Number(target.slice(separator + 1));
    const upstream = net.connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(client);
    sockets.add(upstream);
    client.once("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    client.once("error", () => upstream.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("forward proxy did not bind a TCP port");
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForManagedContainersToDisappear(binary) {
  let listed = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    listed = JSON.parse(await capture(binary, ["list", "--all", "--format", "json"]));
    if (!listed.some((item) => String(item.configuration?.id ?? "").startsWith("pi-sbx-"))) return listed;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return listed;
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
}
