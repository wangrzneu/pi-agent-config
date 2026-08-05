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

test("gitIdentityEnv pins author and committer identity", () => {
  const env = gitIdentityEnv({ name: "Jane", email: "jane@example.com" });
  assert.equal(env.GIT_AUTHOR_NAME, "Jane");
  assert.equal(env.GIT_AUTHOR_EMAIL, "jane@example.com");
  assert.equal(env.GIT_COMMITTER_NAME, "Jane");
  assert.equal(env.GIT_COMMITTER_EMAIL, "jane@example.com");
});

test("gitIdentityEnv returns an empty env without an identity", () => {
  assert.deepEqual(gitIdentityEnv(undefined), {});
});
