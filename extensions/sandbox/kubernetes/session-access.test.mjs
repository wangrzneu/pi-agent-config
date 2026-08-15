import assert from "node:assert/strict";
import { access as fileAccess, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KubernetesSessionAccess } from "./session-access.ts";

function createDependencies() {
  const stopped = [];
  const revoked = [];
  let sequence = 0;
  return {
    broker: {
      async start({ context }) {
        sequence += 1;
        return { id: `proxy-${sequence}`, context, upstream: `http://127.0.0.1:${41000 + sequence}` };
      },
      async stop(id) { stopped.push(id); },
      async stopAll() {},
    },
    gateway: {
      grant({ context }) {
        return {
          id: `grant-${context}`,
          context,
          capability: `capability-${context}`,
          server: "https://127.0.0.1:4443",
        };
      },
      revoke(id) { revoked.push(id); },
      async stop() {},
    },
    stopped,
    revoked,
  };
}

test("session access writes only selected contexts and rewrites on revoke", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-kube-session-"));
  const dependencies = createDependencies();
  const access = new KubernetesSessionAccess({
    broker: dependencies.broker,
    gateway: dependencies.gateway,
    kubeconfigPath: join(root, "config.json"),
    gatewayCaData: "ephemeral-ca",
  });

  await access.grant({
    metadata: {
      name: "dev-admin",
      cluster: "dev",
      server: "https://real-dev.example.com",
      user: "dev-user",
      namespace: "team-a",
      authentication: "exec",
      execCommand: "aws",
    },
    kubectl: "/host/kubectl",
    env: { KUBECONFIG: "/host/.kube/config" },
    access: "observe",
    namespaces: ["team-a"],
  });
  await access.grant({
    metadata: {
      name: "staging",
      cluster: "staging",
      server: "https://real-staging.example.com",
      user: "staging-user",
      authentication: "token",
    },
    kubectl: "/host/kubectl",
    env: {},
    access: "rbac",
  });

  let config = JSON.parse(await readFile(access.kubeconfigPath, "utf8"));
  assert.deepEqual(config.contexts.map((entry) => entry.name), ["dev-admin", "staging"]);
  assert.doesNotMatch(JSON.stringify(config), /real-dev|real-staging|dev-user|staging-user/);

  await access.revoke("dev-admin");
  config = JSON.parse(await readFile(access.kubeconfigPath, "utf8"));
  assert.deepEqual(config.contexts.map((entry) => entry.name), ["staging"]);
  assert.deepEqual(dependencies.stopped, ["proxy-1"]);
  assert.deepEqual(dependencies.revoked, ["grant-dev-admin"]);

  await access.revoke("staging");
  await assert.rejects(fileAccess(access.kubeconfigPath), /ENOENT/);
});

test("session access rolls back the host proxy when gateway grant fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-kube-session-rollback-"));
  const dependencies = createDependencies();
  dependencies.gateway.grant = () => { throw new Error("gateway failed"); };
  const access = new KubernetesSessionAccess({
    broker: dependencies.broker,
    gateway: dependencies.gateway,
    kubeconfigPath: join(root, "config.json"),
    gatewayCaData: "ca",
  });
  await assert.rejects(access.grant({
    metadata: {
      name: "dev",
      cluster: "dev",
      server: "https://dev.example.com",
      user: "user",
      authentication: "token",
    },
    kubectl: "kubectl",
    env: {},
    access: "observe",
  }), /gateway failed/);
  assert.deepEqual(dependencies.stopped, ["proxy-1"]);
});
