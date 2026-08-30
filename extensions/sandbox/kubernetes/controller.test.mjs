import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxKubernetesController } from "./controller.ts";
import { KubernetesContextSelectionStore } from "./context-selection-store.ts";

const config = {
  promptOnStart: true,
  defaultAccess: "observe",
  defaultNamespaces: "context",
  persistContextSelection: false,
  credentialMode: "host-broker",
};

test("Kubernetes controller uses host kubectl and injects a sanitized KUBECONFIG", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-kube-controller-"));
  const bin = join(root, "bin");
  const configDirectory = join(root, "sanitized");
  const kubeconfigPath = join(configDirectory, "config.json");
  await mkdir(bin);
  await mkdir(configDirectory);
  await writeFile(join(bin, "kubectl"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(kubeconfigPath, "{}");
  const plan = {
    platform: "darwin-arm64",
    profiles: [{
      id: "kubectl",
      version: "1.32.3",
      source: "local",
      binDirectories: [bin],
      env: {},
      allowRead: [root],
    }],
    env: { PATH: `${bin}:/usr/bin:/bin` },
    allowRead: [],
  };
  const grants = [];
  const access = {
    kubeconfigPath,
    async grant(request) { grants.push(request); },
    async revoke() {},
    async revokeAll() { grants.length = 0; },
    list() { return grants.map((grant) => ({
      context: grant.metadata.name,
      cluster: grant.metadata.cluster,
      namespace: grant.metadata.namespace,
      access: grant.access,
      namespaces: grant.namespaces,
      authentication: grant.metadata.authentication,
    })); },
    async stop() {},
  };
  const controller = new SandboxKubernetesController({
    state: () => ({ active: true, config }),
    environmentPlan: () => plan,
    async contextDiscovery({ kubectl }) {
      assert.equal(kubectl, join(bin, "kubectl"));
      return {
        contexts: [{
          name: "dev",
          cluster: "dev-cluster",
          server: "https://dev.example.com",
          user: "dev-user",
          namespace: "team-a",
          authentication: "token",
        }],
      };
    },
    async accessFactory() { return access; },
    selectionStore: new KubernetesContextSelectionStore(join(root, "selections")),
  });
  const notifications = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      async confirm() { return true; },
      async select() { return "dev"; },
    },
  };

  await controller.grant("dev", ctx);
  assert.equal(grants[0].kubectl, join(bin, "kubectl"));
  assert.equal(plan.env.KUBECONFIG, kubeconfigPath);

  await controller.revokeAll();
  assert.equal(plan.env.KUBECONFIG, undefined);
});
