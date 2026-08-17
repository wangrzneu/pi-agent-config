#!/usr/bin/env node
// Host-side HTTP CONNECT tunnel used by the Apple Container image build.
//
// The build VM lives on the Apple Container NAT subnet and can reach the host
// gateway IP, but Surge (or another local proxy) may reset connections sourced
// from the VM subnet. This tiny proxy binds to the VM gateway, forwards plain
// HTTP and HTTPS CONNECT to the host's own egress, and lets buildkit's apt/npm
// traffic reach the internet.
//
// Usage:
//   node extensions/sandbox/container/build-tunnel-proxy.mjs
//   # then: PI_SANDBOX_BUILD_PROXY=http://<gateway>:8236 build.sh
//
// Env overrides: PI_BUILD_TUNNEL_HOST, PI_BUILD_TUNNEL_PORT (default 8236).

import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";

const CONTAINER_BINARY = process.env.PI_CONTAINER_BINARY ?? "/opt/homebrew/bin/container";
const PORT = Number(process.env.PI_BUILD_TUNNEL_PORT ?? 8236);

function resolveAppleGateway() {
  try {
    const stdout = execFileSync(CONTAINER_BINARY, ["network", "inspect", "default"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const gateway = parsed?.[0]?.status?.ipv4Gateway;
    if (typeof gateway === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(gateway)) return gateway;
  } catch {
    // Fall through to the explicit override / error below.
  }
  return undefined;
}

const HOST = process.env.PI_BUILD_TUNNEL_HOST ?? resolveAppleGateway();
if (!HOST) {
  console.error("Unable to resolve the Apple Container NAT gateway. Set PI_BUILD_TUNNEL_HOST explicitly.");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400);
    return res.end("bad request");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    res.writeHead(400);
    return res.end("unsupported protocol");
  }
  const upstream = target.protocol === "https:" ? https : http;
  const port = target.port || (target.protocol === "https:" ? 443 : 80);
  const proxyReq = upstream.request({
    hostname: target.hostname,
    port,
    path: `${target.pathname}${target.search}`,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(error.message);
  });
  req.pipe(proxyReq);
});

server.on("connect", (req, clientSocket, head) => {
  const [host, rawPort] = req.url.split(":");
  const port = Number(rawPort || 443);
  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", (error) => {
    console.error(`upstream connect failed: ${host}:${port} ${error.message}`);
    clientSocket.destroy();
  });
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(`build tunnel proxy listening on ${HOST}:${PORT}`);
  console.log(`build with: PI_SANDBOX_BUILD_PROXY=http://${HOST}:${PORT} extensions/sandbox/container/build.sh`);
});
