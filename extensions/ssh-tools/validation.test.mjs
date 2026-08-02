import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validateHost,
  validateRemotePath,
  workspaceDownloadPath,
  workspacePath,
  workspaceUploadPath,
} from "./validation.ts";

test("accepts SSH aliases and destinations but rejects option and shell injection", () => {
  assert.doesNotThrow(() => validateHost("staging"));
  assert.doesNotThrow(() => validateHost("deploy@example.com"));
  assert.doesNotThrow(() => validateHost("user@[2001:db8::1]"));
  assert.throws(() => validateHost("-oProxyCommand=bad"), /safe SSH config alias/);
  assert.throws(() => validateHost("host; touch bad"), /safe SSH config alias/);
  assert.throws(() => validateHost("host\nother"), /safe SSH config alias/);
});

test("confines local transfer paths to the workspace", () => {
  assert.equal(workspacePath("/workspace/project", "dist/app.bin"), "/workspace/project/dist/app.bin");
  assert.throws(() => workspacePath("/workspace/project", "../secret"), /current workspace/);
  assert.throws(() => workspacePath("/workspace/project", "/etc/passwd"), /current workspace/);
});

test("rejects remote path control characters", () => {
  assert.doesNotThrow(() => validateRemotePath("/tmp/app package.bin"));
  assert.throws(() => validateRemotePath("/tmp/a\ncommand"), /single line/);
  assert.throws(() => validateRemotePath("/tmp/a\0command"), /single line/);
});

test("rejects transfer paths that escape through symbolic links", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-ssh-paths-"));
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside");
  try {
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, "secret.bin"), "secret");
    await symlink(outside, join(workspace, "escape"));

    await assert.rejects(
      workspaceUploadPath(workspace, "escape/secret.bin"),
      /current workspace/,
    );
    await assert.rejects(
      workspaceDownloadPath(workspace, "escape/download.bin"),
      /current workspace/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
