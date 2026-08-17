#!/usr/bin/env node
// Locate a working host-side HTTP proxy for the Apple Container image build.
//
// Surge (and similar local proxies) normally expose an HTTP proxy on an
// interface-listening port, but that port is profile-dependent (e.g. Surge's
// default 6152 vs a custom 8234). This script:
//   1. resolves the Apple Container NAT gateway via `container network inspect default`,
//   2. lists Surge's TCP LISTEN ports bound to 0.0.0.0,
//   3. probes each candidate with an absolute-URI HTTP request,
//   4. prints the first working `http://<gateway>:<port>` URL.
//
// Usage:
//   export PI_SANDBOX_BUILD_PROXY=$(node extensions/sandbox/container/find-build-proxy.mjs)
//   extensions/sandbox/container/build.sh
//
// Env overrides: PI_CONTAINER_BINARY, PI_FIND_PROXY_GATEWAY.

import { execFileSync } from "node:child_process";
import http from "node:http";

const CONTAINER_BINARY = process.env.PI_CONTAINER_BINARY ?? "/opt/homebrew/bin/container";
// Surge's HTTP API endpoint (external controller) is not an HTTP egress proxy.
const EXCLUDED_PORTS = new Set([8233]);

function resolveAppleGateway() {
  try {
    const stdout = execFileSync(CONTAINER_BINARY, ["network", "inspect", "default"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const gateway = JSON.parse(stdout)?.[0]?.status?.ipv4Gateway;
    if (typeof gateway === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(gateway)) return gateway;
  } catch {
    // Fall through to the explicit override below.
  }
  return undefined;
}

function surgeListenPorts() {
  // `lsof -c Surge` does prefix/fuzzy matching in some macOS releases and can
  // pick up unrelated processes, so resolve the exact PID first.
  let pids;
  try {
    pids = execFileSync("pgrep", ["-x", "Surge"], { encoding: "utf8", timeout: 10_000 })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
  if (pids.length === 0) return [];
  try {
    const stdout = execFileSync("lsof", ["-nP", "-a", ...pids.flatMap((pid) => ["-p", pid]), "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const ports = new Set();
    for (const line of stdout.split("\n")) {
      const match = line.match(/TCP\s+\*:(\d+)\s+\(LISTEN\)/);
      if (match && !EXCLUDED_PORTS.has(Number(match[1]))) ports.add(Number(match[1]));
    }
    return [...ports].sort((left, right) => left - right);
  } catch {
    return [];
  }
}

function probeHttpProxy(host, port) {
  return new Promise((resolve) => {
    const request = http.request({
      host,
      port,
      method: "GET",
      path: "http://1.1.1.1/",
      headers: { host: "1.1.1.1", connection: "close" },
      timeout: 4_000,
    }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

const gateway = process.env.PI_FIND_PROXY_GATEWAY ?? resolveAppleGateway();
if (!gateway) {
  console.error("Unable to resolve the Apple Container NAT gateway. Set PI_FIND_PROXY_GATEWAY explicitly.");
  process.exit(1);
}

const ports = surgeListenPorts();
if (ports.length === 0) {
  console.error("No Surge HTTP proxy ports found bound to 0.0.0.0. Is Surge running with a profile that has http-listen set?");
  process.exit(1);
}

for (const port of ports) {
  if (await probeHttpProxy(gateway, port)) {
    process.stdout.write(`http://${gateway}:${port}\n`);
    process.exit(0);
  }
}

console.error(`No working HTTP proxy found on ${gateway} among ports ${ports.join(", ")}. Start the bundled tunnel proxy instead: node extensions/sandbox/container/build-tunnel-proxy.mjs`);
process.exit(1);
