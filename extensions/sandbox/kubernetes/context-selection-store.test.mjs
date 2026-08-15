import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KubernetesContextSelectionStore } from "./context-selection-store.ts";

test("context selection persistence stores names only and is project-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-kube-selection-"));
  const firstProject = await mkdtemp(join(tmpdir(), "pi-kube-project-a-"));
  const secondProject = await mkdtemp(join(tmpdir(), "pi-kube-project-b-"));
  const store = new KubernetesContextSelectionStore(root);

  await store.save(firstProject, ["dev-admin", "staging"]);
  assert.deepEqual(await store.load(firstProject), ["dev-admin", "staging"]);
  assert.deepEqual(await store.load(secondProject), []);
  await store.clear(firstProject);
  assert.deepEqual(await store.load(firstProject), []);
});

test("context selection persistence rejects unsafe names and malformed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-kube-selection-invalid-"));
  const project = await mkdtemp(join(tmpdir(), "pi-kube-project-invalid-"));
  const store = new KubernetesContextSelectionStore(root);
  await assert.rejects(store.save(project, ["bad\ncontext"]), /Invalid Kubernetes context name/);

  await store.save(project, ["ok"]);
  const path = await store.pathForProject(project);
  await writeFile(path, JSON.stringify({ contexts: ["ok", 42] }));
  await assert.rejects(store.load(project), /persisted selection|context selection state/i);
});
