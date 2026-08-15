import assert from "node:assert/strict";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { DEFAULT_SANDBOX_CONFIG } from "../config.ts";
import { createSandboxedBashOperations, SandboxProcessTracker } from "../process.ts";
import { ensureSandboxTempRoot } from "../sandbox-paths.ts";
import { composeEnvironmentPlan } from "./composer.ts";
import { resolveLocalEnvironments } from "./local-resolver.ts";

const integrationTest = process.env.PI_SANDBOX_ENV_PROCESS_INTEGRATION === "1" ? test : test.skip;

integrationTest("selected local environments execute together in the Process sandbox", async () => {
  const requested = [
    { id: "go" },
    { id: "python" },
    { id: "node" },
    { id: "pnpm" },
    { id: "kubectl" },
  ];
  const profiles = await resolveLocalEnvironments(requested, {
    cwd: process.cwd(),
    env: process.env,
  });
  const plan = composeEnvironmentPlan({
    backend: "process",
    platform: `${process.platform}-${process.arch}`,
    basePath: (process.env.PATH ?? "").split(":").filter(Boolean),
  }, profiles);
  const {
    enabled: _enabled,
    isolation: _isolation,
    hostExec: _hostExec,
    developmentEnvironments: _developmentEnvironments,
    kubernetes: _kubernetes,
    ...runtimeConfig
  } = DEFAULT_SANDBOX_CONFIG;

  await ensureSandboxTempRoot();
  await SandboxManager.initialize(runtimeConfig);
  const tracker = new SandboxProcessTracker();
  const operations = createSandboxedBashOperations(
    SandboxManager,
    tracker,
    () => ({
      filesystem: {
        ...DEFAULT_SANDBOX_CONFIG.filesystem,
        allowRead: [
          ...(DEFAULT_SANDBOX_CONFIG.filesystem.allowRead ?? []),
          ...plan.allowRead,
        ],
      },
    }),
    undefined,
    () => plan.env,
  );
  const chunks = [];
  try {
    const result = await operations.exec(
      [
        "go version",
        "python --version",
        "node --version",
        "pnpm --version",
        "kubectl version --client -o json",
      ].join(" && "),
      process.cwd(),
      { onData: (chunk) => chunks.push(chunk), timeout: 60 },
    );
    const output = Buffer.concat(chunks).toString("utf8");
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /go version go\d/);
    assert.match(output, /Python \d/);
    assert.match(output, /v\d+\.\d+/);
    assert.match(output, /clientVersion/);
  } finally {
    await tracker.stopAll();
    await SandboxManager.reset().catch(() => undefined);
  }
});
