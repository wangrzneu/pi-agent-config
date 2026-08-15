import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { KubectlProxyBroker } from "./proxy-broker.ts";

function fakeChild(output = "Starting to serve on 127.0.0.1:41827\n") {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  queueMicrotask(() => child.stdout.write(output));
  return child;
}

test("broker starts kubectl proxy with fixed argv and returns a loopback upstream", async () => {
  const invocations = [];
  const child = fakeChild();
  const kills = [];
  const broker = new KubectlProxyBroker({
    spawn(executable, args, options) {
      invocations.push({ executable, args, options });
      return child;
    },
    kill(pid, signal) {
      kills.push({ pid, signal });
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", null, signal));
    },
  });
  const started = await broker.start({
    kubectl: "/opt/kubectl",
    context: "dev-admin",
    env: { KUBECONFIG: "/host/.kube/config" },
  });

  assert.equal(started.upstream, "http://127.0.0.1:41827");
  assert.deepEqual(invocations[0].args, [
    "proxy",
    "--context", "dev-admin",
    "--address", "127.0.0.1",
    "--port", "0",
    "--accept-hosts", "^127\\.0\\.0\\.1$",
  ]);
  assert.equal(invocations[0].options.shell, false);
  await broker.stop(started.id);
  assert.deepEqual(kills, [{ pid: -12345, signal: "SIGTERM" }]);
});

test("broker fails closed when kubectl exits or reports an unexpected endpoint", async () => {
  const exited = fakeChild("");
  queueMicrotask(() => {
    exited.exitCode = 1;
    exited.stderr.write("credential helper failed");
    exited.emit("close", 1, null);
  });
  const broker = new KubectlProxyBroker({ spawn: () => exited });
  await assert.rejects(
    broker.start({ kubectl: "kubectl", context: "prod", env: {} }),
    /credential helper failed/,
  );

  const nonLoopback = fakeChild("Starting to serve on 0.0.0.0:8080\n");
  const strict = new KubectlProxyBroker({ spawn: () => nonLoopback, startupTimeoutMs: 50 });
  await assert.rejects(
    strict.start({ kubectl: "kubectl", context: "prod", env: {} }),
    /did not report a loopback endpoint/,
  );
});
