import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKubernetesGatewayTlsMaterial } from "./tls-material.ts";

test("TLS material generation never follows sandbox-controlled output links", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-kube-tls-no-follow-"));
  const target = join(root, "host-target");
  await writeFile(target, "do not overwrite", "utf8");
  await symlink(target, join(root, "gateway.key"));
  await symlink(target, join(root, "gateway.crt"));

  const material = await createKubernetesGatewayTlsMaterial(root);

  assert.equal(await readFile(target, "utf8"), "do not overwrite");
  assert.match(material.key.toString("utf8"), /BEGIN PRIVATE KEY/);
  assert.match(material.cert.toString("utf8"), /BEGIN CERTIFICATE/);
  assert.equal(material.caData, material.cert.toString("base64"));
});
