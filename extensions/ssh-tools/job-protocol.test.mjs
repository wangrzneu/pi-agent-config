import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCancelJobScript,
  buildJobStatusScript,
  buildStartJobScript,
  parseJobStatus,
  parseStartedJob,
} from "./job-protocol.ts";
import { shellQuote } from "./remote-process.ts";

test("shellQuote safely quotes apostrophes", () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});

test("job start protocol embeds command as base64 and parses metadata", () => {
  const command = "printf \"hello ' remote\"";
  const script = buildStartJobScript("job-1", "/tmp/work dir", command);
  assert.match(script, /base64 -d/);
  assert.match(script, /start\.lock/);
  assert.ok(!script.includes(command));

  const directory = Buffer.from("/tmp/jobs/job-1").toString("base64");
  assert.deepEqual(parseStartedJob(`PI_JOB\t4321\t${directory}\n`), {
    pid: 4321,
    directory: "/tmp/jobs/job-1",
  });
});

test("job status protocol parses bounded output and offsets", () => {
  const stdout = Buffer.from("hello\n").toString("base64");
  const stderr = Buffer.from("warning\n").toString("base64");
  const status = parseJobStatus(
    `PI_JOB_STATUS\texited\t4321\t0\t6\t8\nPI_STDOUT\t${stdout}\nPI_STDERR\t${stderr}\n`,
  );
  assert.deepEqual(status, {
    state: "exited",
    pid: 4321,
    exitCode: 0,
    stdoutSize: 6,
    stderrSize: 8,
    stdout: "hello\n",
    stderr: "warning\n",
    stdoutBytes: 6,
    stderrBytes: 8,
  });

  const splitCharacter = parseJobStatus(
    `PI_JOB_STATUS\trunning\t4321\t\t3\t0\nPI_STDOUT\t${Buffer.from([0xe4, 0xbd]).toString("base64")}\nPI_STDERR\t\n`,
  );
  assert.equal(splitCharacter.stdoutBytes, 2);

  assert.match(buildJobStatusScript("/tmp/job's", 12, 4, 1024), /tail -c \+13/);
  assert.match(buildCancelJobScript("/tmp/job", 3), /limit=30/);
});

test("protocol rejects malformed remote metadata", () => {
  assert.throws(() => parseStartedJob("noise"), /job marker/);
  assert.throws(
    () => parseJobStatus("PI_JOB_STATUS\tunknown\t1\t\t0\t0\n"),
    /invalid state/,
  );
});
