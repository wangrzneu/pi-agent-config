import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SANDBOX_CONFIG, mergeSandboxConfig } from "../config.ts";
import { environmentSelectionFlag } from "./selector.ts";

test("startup selector serializes deterministic exact profile requests", () => {
  const config = mergeSandboxConfig(DEFAULT_SANDBOX_CONFIG, {
    developmentEnvironments: {
      profiles: {
        go: { version: "1.24.2" },
        node: { version: "22.14.0" },
        pnpm: { version: "10.6.0" },
      },
    },
  }).developmentEnvironments;
  assert.equal(
    environmentSelectionFlag(["pnpm", "go", "node"], config),
    "go@1.24.2,node@22.14.0,pnpm@10.6.0",
  );
  assert.equal(environmentSelectionFlag([], config), "none");
});
