import assert from "node:assert/strict";
import test from "node:test";
import {
  isRemoteGitCommand,
  splitCommandSegments,
  unwrapShellC,
} from "./git-host-escape.ts";

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

test("detects remote git subcommands in any command segment (F1)", () => {
  assert.equal(isRemoteGitCommand("cd /repo && git push"), true);
  assert.equal(isRemoteGitCommand("cd /repo && git pull origin main"), true);
  assert.equal(isRemoteGitCommand("cd /repo; git fetch"), true);
  assert.equal(isRemoteGitCommand("echo hi; git push"), true);
  assert.equal(isRemoteGitCommand("git status && git push"), true);
});

test("detects submodule update as remote (F2)", () => {
  assert.equal(isRemoteGitCommand("git submodule update"), true);
  assert.equal(isRemoteGitCommand("git submodule update --remote"), true);
});

test("detects remote git inside bash/sh -c wrappers (F3)", () => {
  assert.equal(isRemoteGitCommand('bash -c "git push"'), true);
  assert.equal(isRemoteGitCommand('bash -c "cd /repo && git pull"'), true);
  assert.equal(isRemoteGitCommand("sh -c 'git fetch origin'"), true);
});

test("does not match local-only git commands or literal strings", () => {
  assert.equal(isRemoteGitCommand("git status"), false);
  assert.equal(isRemoteGitCommand("git log --oneline"), false);
  assert.equal(isRemoteGitCommand("git commit -m x"), false);
  assert.equal(isRemoteGitCommand("git merge main"), false);
  assert.equal(isRemoteGitCommand("git rebase main"), false);
  assert.equal(isRemoteGitCommand("git remote -v"), false);
  assert.equal(isRemoteGitCommand("git config user.name x"), false);
  assert.equal(isRemoteGitCommand("git pushup"), false);
  // Literal strings are not commands (no false positives from echo/printf)
  assert.equal(isRemoteGitCommand('echo "git push"'), false);
  assert.equal(isRemoteGitCommand('printf "%s" "git fetch"'), false);
  // Quoted && does not split
  assert.equal(isRemoteGitCommand('git log --grep="a && git push"'), false);
});

test("splitCommandSegments respects quotes and separators", () => {
  assert.deepEqual(splitCommandSegments("cd /repo && git push"), ["cd /repo", "git push"]);
  assert.deepEqual(splitCommandSegments("a; b | c"), ["a", "b", "c"]);
  assert.deepEqual(splitCommandSegments('git log --grep="a && b"'), ['git log --grep="a && b"']);
  assert.deepEqual(splitCommandSegments("bash -c \"cd /repo && git push\""), ['bash -c "cd /repo && git push"']);
});

test("unwrapShellC extracts the quoted command only from -c shells", () => {
  assert.equal(unwrapShellC('bash -c "git push"'), "git push");
  assert.equal(unwrapShellC('sh -c \'git fetch\''), "git fetch");
  assert.equal(unwrapShellC('bash -lc "cd /repo && git pull"'), "cd /repo && git pull");
  assert.equal(unwrapShellC('echo "git push"'), undefined);
  assert.equal(unwrapShellC("git status"), undefined);
});
