import assert from "node:assert/strict";
import test from "node:test";
import { gitIdentityEnv, loadGitIdentity } from "./git-identity.ts";

test("loadGitIdentity returns name and email when both are configured", () => {
  const get = (key) =>
    key === "user.name" ? "Jane Doe" : key === "user.email" ? "jane@example.com" : undefined;
  assert.deepEqual(loadGitIdentity(get), { name: "Jane Doe", email: "jane@example.com" });
});

test("loadGitIdentity returns undefined when identity is incomplete", () => {
  assert.equal(loadGitIdentity((key) => key === "user.name" ? "Jane" : undefined), undefined);
  assert.equal(loadGitIdentity(() => undefined), undefined);
});

test("loadGitIdentity treats getter failures as no identity", () => {
  assert.equal(loadGitIdentity(() => { throw new Error("no git"); }), undefined);
});

test("gitIdentityEnv pins author and committer identity and visible config", () => {
  const env = gitIdentityEnv({ name: "Jane", email: "jane@example.com" });
  assert.equal(env.GIT_AUTHOR_NAME, "Jane");
  assert.equal(env.GIT_AUTHOR_EMAIL, "jane@example.com");
  assert.equal(env.GIT_COMMITTER_NAME, "Jane");
  assert.equal(env.GIT_COMMITTER_EMAIL, "jane@example.com");
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_CONFIG_KEY_0, "user.name");
  assert.equal(env.GIT_CONFIG_VALUE_0, "Jane");
  assert.equal(env.GIT_CONFIG_KEY_1, "user.email");
  assert.equal(env.GIT_CONFIG_VALUE_1, "jane@example.com");
});

test("gitIdentityEnv continues numbering from an existing GIT_CONFIG_COUNT", () => {
  const env = gitIdentityEnv(
    { name: "Jane", email: "jane@example.com" },
    { GIT_CONFIG_COUNT: "3" },
  );
  assert.equal(env.GIT_CONFIG_COUNT, "5");
  assert.equal(env.GIT_CONFIG_KEY_3, "user.name");
  assert.equal(env.GIT_CONFIG_VALUE_3, "Jane");
});

test("gitIdentityEnv returns an empty env without an identity", () => {
  assert.deepEqual(gitIdentityEnv(undefined), {});
});
