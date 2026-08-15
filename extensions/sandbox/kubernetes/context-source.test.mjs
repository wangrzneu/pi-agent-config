import assert from "node:assert/strict";
import test from "node:test";
import { discoverKubernetesContexts } from "./context-source.ts";

const kubeconfig = {
  "current-context": "dev-admin",
  clusters: [
    { name: "dev", cluster: { server: "https://dev.example.com", "certificate-authority-data": "secret-ca" } },
    { name: "prod", cluster: { server: "https://prod.example.com" } },
  ],
  users: [
    { name: "dev-user", user: { exec: { command: "aws", args: ["eks", "get-token"] } } },
    { name: "prod-user", user: { token: "real-production-token", "client-key-data": "private-key" } },
  ],
  contexts: [
    { name: "dev-admin", context: { cluster: "dev", user: "dev-user", namespace: "team-a" } },
    { name: "production", context: { cluster: "prod", user: "prod-user" } },
  ],
};

test("context discovery returns metadata without credential material", async () => {
  const result = await discoverKubernetesContexts({
    kubectl: "/usr/bin/kubectl",
    env: { KUBECONFIG: "/home/user/.kube/config" },
    async run() {
      return JSON.stringify(kubeconfig);
    },
  });

  assert.equal(result.currentContext, "dev-admin");
  assert.deepEqual(result.contexts, [
    {
      name: "dev-admin",
      cluster: "dev",
      server: "https://dev.example.com",
      user: "dev-user",
      namespace: "team-a",
      authentication: "exec",
      execCommand: "aws",
      execArgs: ["eks", "get-token"],
      execEnvironmentNames: [],
      sourceFile: "/home/user/.kube/config",
    },
    {
      name: "production",
      cluster: "prod",
      server: "https://prod.example.com",
      user: "prod-user",
      namespace: undefined,
      authentication: "token",
      execCommand: undefined,
      execArgs: undefined,
      execEnvironmentNames: undefined,
      sourceFile: "/home/user/.kube/config",
    },
  ]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /real-production-token|private-key|secret-ca/);
});

test("context discovery identifies the exact source in merged kubeconfig inputs", async () => {
  const calls = [];
  const result = await discoverKubernetesContexts({
    kubectl: "/usr/bin/kubectl",
    env: { KUBECONFIG: "/kube/first:/kube/second" },
    async run(_executable, args, env) {
      calls.push({ args, source: env.KUBECONFIG });
      if (args[1] === "view") return JSON.stringify(kubeconfig);
      return env.KUBECONFIG === "/kube/first" ? "dev-admin\n" : "production\n";
    },
  });
  assert.deepEqual(result.contexts.map(({ name, sourceFile }) => ({ name, sourceFile })), [
    { name: "dev-admin", sourceFile: "/kube/first" },
    { name: "production", sourceFile: "/kube/second" },
  ]);
  assert.equal(calls.length, 3);
});

test("context discovery rejects malformed and dangling context references", async () => {
  await assert.rejects(discoverKubernetesContexts({
    kubectl: "kubectl",
    env: {},
    async run() { return "not-json"; },
  }), /invalid JSON/);

  await assert.rejects(discoverKubernetesContexts({
    kubectl: "kubectl",
    env: {},
    async run() {
      return JSON.stringify({ contexts: [{ name: "broken", context: { cluster: "missing", user: "user" } }] });
    },
  }), /unknown cluster/);
});
