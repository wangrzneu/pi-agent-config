import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { KubernetesCapabilityGateway } from "./capability-gateway.ts";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("capability gateway confines tokens to one grant, namespace, and observe policy", async () => {
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  const upstreamUrl = await listen(upstream);
  const gateway = new KubernetesCapabilityGateway();
  await gateway.start();
  try {
    const dev = gateway.grant({
      context: "dev",
      upstream: upstreamUrl,
      access: "observe",
      namespaces: ["team-a"],
    });
    const staging = gateway.grant({
      context: "staging",
      upstream: upstreamUrl,
      access: "observe",
      namespaces: ["team-b"],
    });

    const allowed = await fetch(`${dev.server}/api/v1/namespaces/team-a/pods`, {
      headers: { authorization: `Bearer ${dev.capability}` },
    });
    assert.equal(allowed.status, 200);
    assert.equal(requests[0].authorization, undefined, "session capability is never sent upstream");

    const wrongNamespace = await fetch(`${dev.server}/api/v1/namespaces/team-b/pods`, {
      headers: { authorization: `Bearer ${dev.capability}` },
    });
    assert.equal(wrongNamespace.status, 403);

    const mutation = await fetch(`${dev.server}/api/v1/namespaces/team-a/pods`, {
      method: "POST",
      headers: { authorization: `Bearer ${dev.capability}` },
    });
    assert.equal(mutation.status, 403);

    for (const encodedSubresource of ["%65xec", "%70roxy", "%2565xec"]) {
      const bypass = await fetch(
        `${dev.server}/api/v1/namespaces/team-a/pods/example/${encodedSubresource}`,
        { headers: { authorization: `Bearer ${dev.capability}` } },
      );
      assert.equal(bypass.status, 403, `${encodedSubresource} must not bypass observe policy`);
    }

    const crossGrant = await fetch(`${staging.server}/api/v1/namespaces/team-b/pods`, {
      headers: { authorization: `Bearer ${dev.capability}` },
    });
    assert.equal(crossGrant.status, 403);

    gateway.revoke(dev.id);
    const revoked = await fetch(`${dev.server}/version`, {
      headers: { authorization: `Bearer ${dev.capability}` },
    });
    assert.equal(revoked.status, 401);
  } finally {
    await gateway.stop();
    await close(upstream);
  }
});

test("capability gateway never accepts a non-loopback upstream", async () => {
  const gateway = new KubernetesCapabilityGateway();
  await gateway.start();
  try {
    assert.throws(
      () => gateway.grant({
        context: "proxy",
        upstream: "http://169.254.169.254/latest/meta-data",
        access: "observe",
      }),
      /loopback-only/,
    );
    assert.throws(
      () => gateway.grant({
        context: "proxy",
        upstream: "http://10.0.0.5:6443",
        access: "observe",
      }),
      /loopback-only/,
    );
    assert.throws(
      () => gateway.grant({
        context: "proxy",
        upstream: "file:///etc/passwd",
        access: "observe",
      }),
      /HTTP or HTTPS/,
    );
  } finally {
    await gateway.stop();
  }
});

test("RBAC grants pass mutation methods to the fixed loopback upstream", async () => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(201);
    response.end("created");
  });
  const upstreamUrl = await listen(upstream);
  const gateway = new KubernetesCapabilityGateway();
  await gateway.start();
  try {
    assert.throws(
      () => gateway.grant({ context: "invalid", upstream: upstreamUrl, access: "admin" }),
      /access must be observe or rbac/,
    );
    const grant = gateway.grant({ context: "admin", upstream: upstreamUrl, access: "rbac" });
    const response = await fetch(`${grant.server}/apis/apps/v1/namespaces/default/deployments`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.capability}` },
      body: "{}",
    });
    assert.equal(response.status, 201);
  } finally {
    await gateway.stop();
    await close(upstream);
  }
});
