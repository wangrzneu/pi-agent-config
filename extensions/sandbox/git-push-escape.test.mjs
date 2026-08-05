import assert from "node:assert/strict";
import test from "node:test";
import { isGitPushCommand } from "./git-push-escape.ts";

test("detects plain git push forms", () => {
  assert.equal(isGitPushCommand("git push"), true);
  assert.equal(isGitPushCommand("git push origin main"), true);
  assert.equal(isGitPushCommand("git push --force origin feature"), true);
  assert.equal(isGitPushCommand("git -C /repo push"), true);
  assert.equal(isGitPushCommand("git -C /repo -c user.name=x push origin main"), true);
  assert.equal(isGitPushCommand("/usr/bin/git push"), true);
});

test("does not match non-push commands or later segments", () => {
  assert.equal(isGitPushCommand("git status"), false);
  assert.equal(isGitPushCommand("git fetch origin"), false);
  assert.equal(isGitPushCommand("git log --oneline"), false);
  assert.equal(isGitPushCommand("git pushup"), false);
  assert.equal(isGitPushCommand("echo hi; git push"), false); // push is not the first segment
  assert.equal(isGitPushCommand("git config user.name x"), false);
});
