import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONNECTION_POLICY,
  SshAuthorization,
} from "./authorization.ts";

test("grants capabilities per host for one session", () => {
  const authorization = new SshAuthorization();
  assert.deepEqual(authorization.missingCapabilities("staging", ["exec", "files"]), ["exec", "files"]);

  authorization.grant("staging", ["exec"], DEFAULT_CONNECTION_POLICY);
  authorization.assertCapability("staging", "exec");
  assert.deepEqual(authorization.missingCapabilities("staging", ["exec", "files"]), ["files"]);
  assert.throws(() => authorization.assertCapability("staging", "files"), /not authorized/);

  authorization.clearGrants();
  assert.equal(authorization.isConnected("staging"), true);
  assert.throws(() => authorization.assertCapability("staging", "exec"), /this session/);
});

test("stores bounded connection policy per host and resets all authorization", () => {
  const authorization = new SshAuthorization();
  const policy = { connectTimeoutSeconds: 20, retries: 3, retryDelayMs: 750 };
  authorization.grant("build", ["jobs"], policy);
  assert.deepEqual(authorization.policyFor("build"), policy);
  assert.deepEqual(authorization.getHosts(), ["build"]);

  authorization.reset();
  assert.deepEqual(authorization.getHosts(), []);
  assert.deepEqual(authorization.policyFor("build"), DEFAULT_CONNECTION_POLICY);
});
