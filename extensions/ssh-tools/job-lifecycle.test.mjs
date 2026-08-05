import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildCancelJobScript,
  buildJobStatusScript,
  buildStartJobScript,
  parseJobStatus,
  parseStartedJob,
} from "./job-protocol.ts";

function runScript(script, jobRoot) {
  return spawnSync("sh", ["-s"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, PI_SSH_JOB_DIR: jobRoot },
    timeout: 15_000,
  });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("detached job starts, reports output, and exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ssh-jobs-"));
  try {
    // login:false represents a job started without login-environment
    // authorization: a plain shell that does not read ~/.profile, so job
    // stderr stays limited to the command's own output.
    const start = runScript(
      buildStartJobScript("job-complete", root, "printf 'hello'; printf 'warn' >&2", { login: false }),
      root,
    );
    assert.equal(start.status, 0, start.stderr);
    const job = parseStartedJob(start.stdout);

    let status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(50);
      const checked = runScript(buildJobStatusScript(job.directory, 0, 0, 1024), root);
      assert.equal(checked.status, 0, checked.stderr);
      status = parseJobStatus(checked.stdout);
      if (status.state !== "running") break;
    }

    assert.equal(status?.state, "exited");
    assert.equal(status?.exitCode, 0);
    assert.equal(status?.stdout, "hello");
    assert.equal(status?.stderr, "warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detached job can be cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ssh-jobs-"));
  try {
    const start = runScript(buildStartJobScript("job-cancel", root, "sleep 30", { login: false }), root);
    assert.equal(start.status, 0, start.stderr);
    const job = parseStartedJob(start.stdout);

    const cancelled = runScript(buildCancelJobScript(job.directory, 0), root);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /PI_JOB_CANCEL\tcancelled/);

    await wait(50);
    const checked = runScript(buildJobStatusScript(job.directory, 0, 0, 1024), root);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(parseJobStatus(checked.stdout).state, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeating the same start request reuses the remote job", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ssh-jobs-"));
  try {
    const script = buildStartJobScript(
      "job-retry",
      root,
      "printf x >> count; sleep 0.5",
      { login: false },
    );
    const first = runScript(script, root);
    const second = runScript(script, root);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(parseStartedJob(first.stdout).pid, parseStartedJob(second.stdout).pid);

    await wait(700);
    assert.equal(await readFile(join(root, "count"), "utf8"), "x");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authorized jobs use a login shell; unauthorized jobs use a plain shell", () => {
  const authorized = buildStartJobScript("job-login", "/tmp", "echo hi");
  const unauthorized = buildStartJobScript("job-plain", "/tmp", "echo hi", { login: false });
  // Login shell reads ~/.profile and friends so the job inherits the environment.
  assert.match(authorized, /sh -lc "\$command_text"/);
  // Plain shell does not read profile files, keeping job output side-effect free.
  assert.doesNotMatch(authorized, /sh -c "\$command_text"/);
  assert.match(unauthorized, /sh -c "\$command_text"/);
  assert.doesNotMatch(unauthorized, /sh -lc/);
});
