import assert from "node:assert/strict";
import test from "node:test";
import {
  needsHostExecution,
  splitCommandSegments,
  stripCommandWrappers,
  unwrapShellC,
} from "./host-escape.ts";

test("detects remote git subcommands", () => {
  for (const sub of ["push", "pull", "fetch", "clone", "ls-remote"]) {
    assert.equal(needsHostExecution(`git ${sub}`), true, `git ${sub}`);
    assert.equal(needsHostExecution(`git ${sub} origin main`), true, `git ${sub} origin main`);
  }
  assert.equal(needsHostExecution("git push --force origin feature"), true);
  assert.equal(needsHostExecution("git -C /repo push"), true);
  assert.equal(needsHostExecution("git -C /repo -c user.name=x pull origin main"), true);
  assert.equal(needsHostExecution("/usr/bin/git fetch"), true);
});

test("detects remote git subcommands in any command segment (F1)", () => {
  assert.equal(needsHostExecution("cd /repo && git push"), true);
  assert.equal(needsHostExecution("cd /repo && git pull origin main"), true);
  assert.equal(needsHostExecution("cd /repo; git fetch"), true);
  assert.equal(needsHostExecution("echo hi; git push"), true);
  assert.equal(needsHostExecution("git status && git push"), true);
});

test("detects submodule update as remote (F2)", () => {
  assert.equal(needsHostExecution("git submodule update"), true);
  assert.equal(needsHostExecution("git submodule update --remote"), true);
});

test("detects remote git inside bash/sh -c wrappers (F3)", () => {
  assert.equal(needsHostExecution('bash -c "git push"'), true);
  assert.equal(needsHostExecution('bash -c "cd /repo && git pull"'), true);
  assert.equal(needsHostExecution("sh -c 'git fetch origin'"), true);
});

test("detects gh (GitHub CLI) invocations", () => {
  assert.equal(needsHostExecution("gh pr create"), true);
  assert.equal(needsHostExecution("gh pr view --web"), true);
  assert.equal(needsHostExecution("gh issue list --state open"), true);
  assert.equal(needsHostExecution("gh repo create my-repo --public"), true);
  assert.equal(needsHostExecution("gh api user"), true);
  assert.equal(needsHostExecution("gh auth status"), true);
  assert.equal(needsHostExecution("gh run watch 123"), true);
  assert.equal(needsHostExecution("gh release create v1.0.0"), true);
  assert.equal(needsHostExecution("/usr/local/bin/gh pr create"), true);
  assert.equal(needsHostExecution("gh --version"), true);
});

test("detects gh in any command segment and inside wrappers", () => {
  assert.equal(needsHostExecution("cd /repo && gh pr create"), true);
  assert.equal(needsHostExecution("echo hi; gh auth login"), true);
  assert.equal(needsHostExecution("git status && gh pr view"), true);
  assert.equal(needsHostExecution('bash -c "gh repo create"'), true);
  assert.equal(needsHostExecution('bash -c "cd /repo && gh issue list"'), true);
});

test("detects gh and remote git behind command wrappers", () => {
  assert.equal(needsHostExecution("sudo gh pr create"), true);
  assert.equal(needsHostExecution("sudo -u deploy gh repo create my-repo --public"), true);
  assert.equal(needsHostExecution("sudo -n gh auth login"), true);
  assert.equal(needsHostExecution("nohup gh api user > /tmp/gh.out 2>&1 &"), true);
  assert.equal(needsHostExecution("command gh pr view"), true);
  assert.equal(needsHostExecution("exec gh release create v1.0.0"), true);
  assert.equal(needsHostExecution("env GH_TOKEN=xxx gh auth status"), true);
  assert.equal(needsHostExecution("sudo git push origin main"), true);
  assert.equal(needsHostExecution("nohup git fetch origin"), true);
  assert.equal(needsHostExecution("sudo nohup git push"), true);
});

test("stripCommandWrappers removes wrappers but not commands", () => {
  assert.equal(stripCommandWrappers("sudo gh pr create"), "gh pr create");
  assert.equal(stripCommandWrappers("sudo -u deploy gh pr create"), "gh pr create");
  assert.equal(stripCommandWrappers("sudo -n git push"), "git push");
  assert.equal(stripCommandWrappers("nohup gh api user"), "gh api user");
  assert.equal(stripCommandWrappers("command git fetch"), "git fetch");
  assert.equal(stripCommandWrappers("exec gh pr create"), "gh pr create");
  assert.equal(stripCommandWrappers("env GH_TOKEN=x GH_HOST=git.company gh auth status"), "gh auth status");
  assert.equal(stripCommandWrappers("sudo nohup git push"), "git push");
  // Non-wrapper prefixes are untouched
  assert.equal(stripCommandWrappers("pip install gh"), "pip install gh");
  assert.equal(stripCommandWrappers("cd /repo && git push"), "cd /repo && git push");
  assert.equal(stripCommandWrappers("echo gh pr create"), "echo gh pr create");
});

test("does not match local-only git commands, non-gh words, or literal strings", () => {
  assert.equal(needsHostExecution("git status"), false);
  assert.equal(needsHostExecution("git log --oneline"), false);
  assert.equal(needsHostExecution("git commit -m x"), false);
  assert.equal(needsHostExecution("git merge main"), false);
  assert.equal(needsHostExecution("git rebase main"), false);
  assert.equal(needsHostExecution("git remote -v"), false);
  assert.equal(needsHostExecution("git config user.name x"), false);
  assert.equal(needsHostExecution("git pushup"), false);
  // gh is an exact command word; substrings or lookalikes do not match
  assert.equal(needsHostExecution("mygh pr create"), false);
  assert.equal(needsHostExecution("ghpr create"), false);
  assert.equal(needsHostExecution("g h"), false);
  // Literal strings are not commands (no false positives from echo/printf)
  assert.equal(needsHostExecution('echo "git push"'), false);
  assert.equal(needsHostExecution('printf "%s" "git fetch"'), false);
  assert.equal(needsHostExecution('echo "gh pr create"'), false);
  // Quoted && does not split
  assert.equal(needsHostExecution('git log --grep="a && git push"'), false);
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
