import assert from "node:assert/strict";
import test from "node:test";
import { resolveEnvironmentSelection } from "./selection.ts";

const config = {
  selected: ["python", "go"],
  profiles: {
    go: { version: "1.24.2", source: "auto" },
    python: { version: "3.13.2", source: "auto" },
    node: { version: "22.14.0", source: "auto" },
    pnpm: { version: "10.6.0", storeScope: "project" },
    kubectl: { version: "1.32.3", source: "auto" },
  },
};

test("configured environments resolve in deterministic dependency order", () => {
  assert.deepEqual(resolveEnvironmentSelection(undefined, config), [
    { id: "go", requestedVersion: "1.24.2" },
    { id: "python", requestedVersion: "3.13.2" },
  ]);
});

test("CLI environment selection overrides configuration and supports all profiles", () => {
  assert.deepEqual(
    resolveEnvironmentSelection(
      "kubectl@1.31.7,pnpm@10.7.0,python@3.12.9,go@1.23.6",
      config,
    ),
    [
      { id: "go", requestedVersion: "1.23.6" },
      { id: "python", requestedVersion: "3.12.9" },
      { id: "node", requestedVersion: "22.14.0", implicit: true },
      { id: "pnpm", requestedVersion: "10.7.0" },
      { id: "kubectl", requestedVersion: "1.31.7" },
    ],
  );
});

test("pnpm automatically requests the configured Node.js profile", () => {
  assert.deepEqual(resolveEnvironmentSelection("pnpm@10.6.0", config), [
    { id: "node", requestedVersion: "22.14.0", implicit: true },
    { id: "pnpm", requestedVersion: "10.6.0" },
  ]);
});

test("none explicitly clears configured environment selection", () => {
  assert.deepEqual(resolveEnvironmentSelection("none", config), []);
});

test("invalid, duplicate, and ambiguous selections are rejected", () => {
  assert.throws(() => resolveEnvironmentSelection("rust@1.0", config), /Unknown sandbox environment/);
  assert.throws(() => resolveEnvironmentSelection("go@1.24,go@1.23", config), /Duplicate sandbox environment/);
  assert.throws(() => resolveEnvironmentSelection("none,go@1.24", config), /must be selected alone/);
  assert.throws(() => resolveEnvironmentSelection("go@../../tmp", config), /Invalid version/);
});
