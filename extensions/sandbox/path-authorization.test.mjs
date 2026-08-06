import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxPathAuthorization } from "./path-authorization.ts";

test("workspace reads are allowed and external reads require a grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-read-auth-"));
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  await mkdir(workspace);
  await mkdir(external);
  await writeFile(join(workspace, "inside.txt"), "inside");
  await writeFile(join(external, "outside.txt"), "outside");
  const authorization = new SandboxPathAuthorization({ allowOsTemp: false });
  await authorization.reset(workspace);

  assert.equal(await authorization.isAllowed("inside.txt", workspace), true);
  assert.equal(await authorization.isAllowed(join(external, "outside.txt"), workspace), false);

  const grant = await authorization.inspect(external, workspace);
  authorization.grant(grant);
  assert.equal(await authorization.isAllowed(join(external, "outside.txt"), workspace), true);
  assert.deepEqual(authorization.paths(), [grant.path]);
});

test("workspace symlinks cannot bypass external read authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-read-symlink-"));
  const workspace = join(root, "workspace");
  const external = join(root, "outside.txt");
  await mkdir(workspace);
  await writeFile(external, "outside");
  await symlink(external, join(workspace, "link.txt"));
  const authorization = new SandboxPathAuthorization({ allowOsTemp: false });
  await authorization.reset(workspace);

  assert.equal(await authorization.isAllowed("link.txt", workspace), false);
});

test("a missing child below an external symlink remains outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-read-missing-symlink-"));
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  await mkdir(workspace);
  await mkdir(external);
  await symlink(external, join(workspace, "external-dir"));
  const authorization = new SandboxPathAuthorization({ allowOsTemp: false });
  await authorization.reset(workspace);

  assert.equal(
    await authorization.isAllowed("external-dir/not-created.txt", workspace),
    false,
  );
});

test("write authorization can grant one not-yet-created external file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-write-missing-"));
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  await mkdir(workspace);
  await mkdir(external);
  const target = join(external, "new-file.txt");
  const authorization = new SandboxPathAuthorization({ allowOsTemp: false });
  await authorization.reset(workspace);

  const grant = await authorization.inspect(target, workspace, { allowMissing: true });
  authorization.grant(grant);

  assert.equal(await authorization.isAllowed(target, workspace), true);
  assert.equal(await authorization.isAllowed(join(external, "other.txt"), workspace), false);
});

test("OS temp files are readable from another workspace by default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-read-workspace-"));
  const tempFile = join(tmpdir(), `pi-read-os-temp-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(tempFile, "transient");
  const authorization = new SandboxPathAuthorization(); // allowOsTemp defaults true
  await authorization.reset(workspace);

  assert.equal(await authorization.isAllowed(tempFile, workspace), true);
  // …but with the option disabled, only workspace + grants remain allowed.
  const strict = new SandboxPathAuthorization({ allowOsTemp: false });
  await strict.reset(workspace);
  assert.equal(await strict.isAllowed(tempFile, workspace), false);
});

test("Pi managed resource roots are readable without a grant", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-read-workspace-"));
  const root = await mkdtemp(join(tmpdir(), "pi-agent-dir-like-"));
  const skillsRoot = join(root, "skills");
  const sensitive = join(root, "settings.json");
  await mkdir(skillsRoot);
  await writeFile(join(skillsRoot, "SKILL.md"), "guidance");
  await writeFile(sensitive, "secret");

  const authorization = new SandboxPathAuthorization({
    allowOsTemp: false,
    piReadRoots: [skillsRoot],
  });
  await authorization.reset(workspace);

  assert.equal(await authorization.isAllowed(join(skillsRoot, "SKILL.md"), workspace), true);
  // The agent dir root itself (settings.json) is not inside a managed root.
  assert.equal(await authorization.isAllowed(sensitive, workspace), false);
});

test("~/.agents/skills is readable when listed as a Pi read root", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-agents-ws-"));
  const agentsHome = await mkdtemp(join(tmpdir(), "pi-agents-home-"));
  const skills = join(agentsHome, ".agents", "skills");
  await mkdir(skills, { recursive: true });
  const skillFile = join(skills, "SKILL.md");
  await writeFile(skillFile, "guidance");

  const authorization = new SandboxPathAuthorization({
    allowOsTemp: false,
    piReadRoots: [skills],
  });
  await authorization.reset(workspace);

  assert.equal(await authorization.isAllowed(skillFile, workspace), true);
  // Sibling paths outside ~/.agents/skills stay blocked.
  assert.equal(
    await authorization.isAllowed(join(agentsHome, ".agents", "settings.json"), workspace),
    false,
  );
});

test("read grants are cleared when authorization resets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-read-reset-"));
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  const authorization = new SandboxPathAuthorization({ allowOsTemp: false });
  await authorization.reset(first);
  authorization.grant(await authorization.inspect(second, first));

  await authorization.reset(first);

  assert.deepEqual(authorization.paths(), []);
  assert.equal(await authorization.isAllowed(second, first), false);
});
