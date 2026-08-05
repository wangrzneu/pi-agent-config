import assert from "node:assert/strict";
import test from "node:test";
import { isRemoteGitCommand } from "./git-host-escape.ts";

test("detects remote git subcommands", () => {
  for (const sub of ["push", "pull", "fetch", "clone", "ls-remote"]) {
    assert.equal(isRemoteGitCommand(`git ${sub}`), true, `git ${sub}`);
    assert.equal(isRemoteGitCommand(`git ${sub} origin main`), true, `git ${sub} origin main`);
  }
  assert.equal(isRemoteGitCommand("git push --force origin feature"), true);
  assert.equal(isRemoteGitCommand("git -C /repo push"), true);
  assert.equal(isRemoteGitCommand("git -C /repo -c user.name=x pull origin main"), true);
  assert.equal(isRemoteGitCommand("/usr/bin/git fetch"), true);
});

test("does not match local-only git commands or later segments", () => {
  assert.equal(isRemoteGitCommand("git status"), false);
  assert.equal(isRemoteGitCommand("git log --oneline"), false);
  assert.equal(isRemoteGitCommand("git commit -m x"), false);
  assert.equal(isRemoteGitCommand("git merge main"), false);
  assert.equal(isRemoteGitCommand("git rebase main"), false);
  assert.equal(isRemoteGitCommand("git remote -v"), false);
  assert.equal(isRemoteGitCommand("echo hi; git push"), false); // not the first segment
  assert.equal(isRemoteGitCommand("git config user.name x"), false);
});
