import assert from "node:assert/strict";
import test from "node:test";
import {
  matchHostExecCommand,
  splitCommandSegments,
  stripCommandWrappers,
  unwrapShellC,
} from "./host-escape.ts";

/** Boolean convenience for the matchHostExecCommand-based assertions below. */
function hostExec(command, extraPrefixes) {
  return matchHostExecCommand(command, extraPrefixes) !== undefined;
}

test("detects remote git subcommands", () => {
  for (const sub of ["push", "pull", "fetch", "clone", "ls-remote"]) {
    assert.equal(hostExec(`git ${sub}`), true, `git ${sub}`);
    assert.equal(hostExec(`git ${sub} origin main`), true, `git ${sub} origin main`);
  }
  assert.equal(hostExec("git push --force origin feature"), true);
  assert.equal(hostExec("git -C /repo push"), true);
  assert.equal(hostExec("git -C /repo -c user.name=x pull origin main"), true);
  assert.equal(hostExec("/usr/bin/git fetch"), true);
});

test("detects remote git subcommands in any command segment (F1)", () => {
  assert.equal(hostExec("cd /repo && git push"), true);
  assert.equal(hostExec("cd /repo && git pull origin main"), true);
  assert.equal(hostExec("cd /repo; git fetch"), true);
  assert.equal(hostExec("echo hi; git push"), true);
  assert.equal(hostExec("git status && git push"), true);
});

test("detects submodule update as remote (F2)", () => {
  assert.equal(hostExec("git submodule update"), true);
  assert.equal(hostExec("git submodule update --remote"), true);
});

test("detects remote git inside bash/sh -c wrappers (F3)", () => {
  assert.equal(hostExec('bash -c "git push"'), true);
  assert.equal(hostExec('bash -c "cd /repo && git pull"'), true);
  assert.equal(hostExec("sh -c 'git fetch origin'"), true);
});

test("detects gh (GitHub CLI) invocations", () => {
  assert.equal(hostExec("gh pr create"), true);
  assert.equal(hostExec("gh pr view --web"), true);
  assert.equal(hostExec("gh issue list --state open"), true);
  assert.equal(hostExec("gh repo create my-repo --public"), true);
  assert.equal(hostExec("gh api user"), true);
  assert.equal(hostExec("gh auth status"), true);
  assert.equal(hostExec("gh run watch 123"), true);
  assert.equal(hostExec("gh release create v1.0.0"), true);
  assert.equal(hostExec("/usr/local/bin/gh pr create"), true);
  assert.equal(hostExec("gh --version"), true);
});

test("detects gh in any command segment and inside wrappers", () => {
  assert.equal(hostExec("cd /repo && gh pr create"), true);
  assert.equal(hostExec("echo hi; gh auth login"), true);
  assert.equal(hostExec("git status && gh pr view"), true);
  assert.equal(hostExec('bash -c "gh repo create"'), true);
  assert.equal(hostExec('bash -c "cd /repo && gh issue list"'), true);
});

test("detects gh and remote git behind command wrappers", () => {
  assert.equal(hostExec("sudo gh pr create"), true);
  assert.equal(hostExec("sudo -u deploy gh repo create my-repo --public"), true);
  assert.equal(hostExec("sudo -n gh auth login"), true);
  assert.equal(hostExec("nohup gh api user > /tmp/gh.out 2>&1 &"), true);
  assert.equal(hostExec("command gh pr view"), true);
  assert.equal(hostExec("exec gh release create v1.0.0"), true);
  assert.equal(hostExec("env GH_TOKEN=xxx gh auth status"), true);
  assert.equal(hostExec("sudo git push origin main"), true);
  assert.equal(hostExec("nohup git fetch origin"), true);
  assert.equal(hostExec("sudo nohup git push"), true);
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

test("matchHostExecCommand returns the matched command word", () => {
  assert.deepEqual(matchHostExecCommand("git push"), { word: "git" });
  assert.deepEqual(matchHostExecCommand("gh pr view"), { word: "gh" });
  assert.deepEqual(matchHostExecCommand("cd /repo && git fetch"), { word: "git" });
  assert.deepEqual(matchHostExecCommand('bash -c "git pull"'), { word: "git" });
  assert.equal(matchHostExecCommand("git status"), undefined);
  assert.equal(matchHostExecCommand("ls"), undefined);
});

test("extra configured prefixes match on the first command word only", () => {
  const extra = ["aws", "gcloud", "docker"];
  assert.deepEqual(matchHostExecCommand("aws s3 ls", extra), { word: "aws" });
  assert.deepEqual(matchHostExecCommand("aws", extra), { word: "aws" });
  assert.deepEqual(matchHostExecCommand("/usr/local/bin/aws sts get-caller-identity", extra), { word: "aws" });
  assert.deepEqual(matchHostExecCommand("gcloud auth list", extra), { word: "gcloud" });
  assert.deepEqual(matchHostExecCommand("sudo docker push app:latest", extra), { word: "docker" });
  assert.deepEqual(matchHostExecCommand("cd x && aws ec2 describe-instances", extra), { word: "aws" });
  assert.deepEqual(matchHostExecCommand('bash -c "gcloud config list"', extra), { word: "gcloud" });
  // Not a command word -> no match
  assert.equal(matchHostExecCommand("echo aws s3", extra), undefined);
  assert.equal(matchHostExecCommand("awsx s3 ls", extra), undefined);
  assert.equal(matchHostExecCommand("pip install awscli", extra), undefined);
  // Without configured prefixes, extra tools are not matched
  assert.equal(matchHostExecCommand("aws s3 ls"), undefined);
});

test("built-in git/gh detection does not need the extra list", () => {
  assert.equal(hostExec("git push"), true);
  assert.equal(hostExec("gh pr view"), true);
  assert.equal(hostExec("aws s3 ls"), false);
  assert.equal(hostExec("aws s3 ls", ["aws"]), true);
});

test("matchHostExecCommand never matches local-only git", () => {
  assert.equal(matchHostExecCommand("git status"), undefined);
  assert.equal(matchHostExecCommand("git commit -m x"), undefined);
  assert.equal(matchHostExecCommand("git log"), undefined);
});

test("does not match local-only git commands, non-gh words, or literal strings", () => {
  assert.equal(hostExec("git status"), false);
  assert.equal(hostExec("git log --oneline"), false);
  assert.equal(hostExec("git commit -m x"), false);
  assert.equal(hostExec("git merge main"), false);
  assert.equal(hostExec("git rebase main"), false);
  assert.equal(hostExec("git remote -v"), false);
  assert.equal(hostExec("git config user.name x"), false);
  assert.equal(hostExec("git pushup"), false);
  // gh is an exact command word; substrings or lookalikes do not match
  assert.equal(hostExec("mygh pr create"), false);
  assert.equal(hostExec("ghpr create"), false);
  assert.equal(hostExec("g h"), false);
  // Literal strings are not commands (no false positives from echo/printf)
  assert.equal(hostExec('echo "git push"'), false);
  assert.equal(hostExec('printf "%s" "git fetch"'), false);
  assert.equal(hostExec('echo "gh pr create"'), false);
  // Quoted && does not split
  assert.equal(hostExec('git log --grep="a && git push"'), false);
});

test("matchHostExecCommand matches extra prefixes without the extra list for git/gh only", () => {
  // The recursion through bash -c also re-applies extra prefixes to inner commands
  assert.deepEqual(matchHostExecCommand('bash -c "aws s3 ls"', ["aws"]), { word: "aws" });
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
