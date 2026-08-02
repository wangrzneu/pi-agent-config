import assert from "node:assert/strict";
import test from "node:test";
import {
  isRetryableConnectionFailure,
  runWithConnectionRetry,
} from "./connection-retry.ts";
import { scpArguments, sshArguments } from "./remote-process.ts";

const result = (stderr, exitCode = 255) => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(stderr),
  exitCode,
  signal: null,
  timedOut: false,
  aborted: false,
  truncated: false,
});

test("retries connection failures with exponential backoff", async () => {
  const attempts = [
    result("ssh: connect to host staging port 22: Connection refused"),
    result("ssh: connect to host staging port 22: Connection timed out"),
    result("", 0),
  ];
  const delays = [];
  const final = await runWithConnectionRetry(
    async () => attempts.shift(),
    { connectTimeoutSeconds: 5, retries: 3, retryDelayMs: 100 },
    "connect",
    undefined,
    async (delay) => delays.push(delay),
  );
  assert.equal(final.exitCode, 0);
  assert.equal(final.attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("retries authentication and host-key failures", () => {
  assert.equal(isRetryableConnectionFailure(result("Permission denied (publickey,password)."), "connect"), true);
  assert.equal(isRetryableConnectionFailure(result("Authentication failed."), "transport"), true);
  assert.equal(isRetryableConnectionFailure(result("Host key verification failed."), "connect"), true);
  assert.equal(
    isRetryableConnectionFailure(result("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!"), "transport"),
    true,
  );
  assert.equal(
    isRetryableConnectionFailure(
      result("No ED25519 host key is known for staging and you have requested strict checking."),
      "connect",
    ),
    true,
  );
});

test("does not retry remote exit or operation timeout failures", () => {
  assert.equal(isRetryableConnectionFailure(result("Connection refused", 23), "transport"), false);
  assert.equal(
    isRetryableConnectionFailure({ ...result("Connection refused"), timedOut: true }, "transport"),
    false,
  );
});

test("limits ambiguous disconnect retries to idempotent transport operations", () => {
  const disconnected = result("client_loop: send disconnect: Broken pipe");
  assert.equal(isRetryableConnectionFailure(disconnected, "connect"), false);
  assert.equal(isRetryableConnectionFailure(disconnected, "transport"), true);
});

test("does not mistake remote command stderr for an OpenSSH connection failure", () => {
  assert.equal(
    isRetryableConnectionFailure(result("application: Connection refused"), "connect"),
    false,
  );
});

test("passes the configured connection timeout to OpenSSH", () => {
  assert.ok(sshArguments("staging", undefined, 17).includes("ConnectTimeout=17"));
  assert.ok(scpArguments(undefined, 23).includes("ConnectTimeout=23"));
});
