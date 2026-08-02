import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    timeout: 10_000,
  });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("detached job starts, reports output, and exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ssh-jobs-"));
  try {
    const start = runScript(
      buildStartJobScript("job-complete", root, "printf 'hello'; printf 'warn' >&2"),
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
    const start = runScript(buildStartJobScript("job-cancel", root, "sleep 30"), root);
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
