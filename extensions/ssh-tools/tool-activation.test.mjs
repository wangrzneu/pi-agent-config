import assert from "node:assert/strict";
import test from "node:test";
import { SshToolActivation } from "./tool-activation.ts";

function fakePi(initial) {
  let active = [...initial];
  return {
    getActiveTools: () => [...active],
    setActiveTools: (next) => { active = [...next]; },
  };
}

test("preserves unrelated active tools while exposing SSH groups", () => {
  const pi = fakePi(["read", "bash", "ssh_exec"]);
  const activation = new SshToolActivation(pi);

  activation.sync();
  assert.deepEqual(pi.getActiveTools(), ["read", "bash", "ssh_enable"]);

  activation.activate(["files", "exec"]);
  assert.deepEqual(pi.getActiveTools(), [
    "read",
    "bash",
    "ssh_enable",
    "ssh_upload",
    "ssh_download",
    "ssh_exec",
  ]);
});

test("withdraws turn tools but retains job lifecycle tools", () => {
  const pi = fakePi(["read"]);
  const activation = new SshToolActivation(pi);
  activation.activate(["jobs"]);
  activation.setJobCounts(1, 1);

  activation.settle();
  assert.deepEqual(pi.getActiveTools(), [
    "read",
    "ssh_enable",
    "ssh_job_status",
    "ssh_job_cancel",
  ]);

  activation.setJobCounts(1, 0);
  assert.deepEqual(pi.getActiveTools(), ["read", "ssh_enable", "ssh_job_status"]);
});

test("suspension and disablement remove only SSH tools", () => {
  const pi = fakePi(["read", "custom"]);
  const activation = new SshToolActivation(pi);
  activation.activate(["exec"]);

  activation.sync(true);
  assert.deepEqual(pi.getActiveTools(), ["read", "custom"]);

  activation.setEnabled(false);
  assert.deepEqual(pi.getActiveTools(), ["read", "custom"]);
});
