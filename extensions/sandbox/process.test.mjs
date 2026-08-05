import assert from "node:assert/strict";
import test from "node:test";
import {
  codingCacheEnvironment,
  createSandboxedBashOperations,
  SandboxProcessTracker,
} from "./process.ts";

function createRuntime() {
  let cleanups = 0;
  return {
    runtime: {
      async wrapWithSandbox(command) {
        return command;
      },
      cleanupAfterCommand() {
        cleanups += 1;
      },
    },
    cleanupCount() {
      return cleanups;
    },
  };
}

test("coding caches are redirected into a writable process-scoped temp area", () => {
  const env = codingCacheEnvironment({ PATH: "/bin", npm_config_cache: "/host/cache" });

  assert.equal(env.PATH, "/bin");
  assert.match(env.TMPDIR, /pi-sandbox-\d+-[0-9a-f-]+\/tmp$/);
  assert.match(env.npm_config_cache, /pi-sandbox-\d+-[0-9a-f-]+\/cache\/npm$/);
  assert.equal(env.npm_config_store_dir, env.pnpm_config_store_dir);
  assert.match(env.npm_config_store_dir, /pi-sandbox-\d+-[0-9a-f-]+\/cache\/pnpm-store$/);
  assert.match(env.CARGO_HOME, /pi-sandbox-\d+-[0-9a-f-]+\/cache\/cargo$/);
  assert.match(env.GOMODCACHE, /pi-sandbox-\d+-[0-9a-f-]+\/cache\/go-mod$/);
  assert.match(env.GOPATH, /pi-sandbox-\d+-[0-9a-f-]+\/cache\/go-path$/);
});

test("sandboxed bash streams output and preserves the child exit code", async () => {
  const fake = createRuntime();
  const operations = createSandboxedBashOperations(
    fake.runtime,
    new SandboxProcessTracker(),
  );
  const chunks = [];

  const result = await operations.exec("printf 'sandbox output'", process.cwd(), {
    onData: (chunk) => chunks.push(chunk),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "sandbox output");
  assert.equal(fake.cleanupCount(), 1);
});

test("sandboxed bash has no implicit timeout", async () => {
  const fake = createRuntime();
  const operations = createSandboxedBashOperations(
    fake.runtime,
    new SandboxProcessTracker(),
  );

  const result = await operations.exec("sleep 0.05; printf done", process.cwd(), {
    onData() {},
  });

  assert.equal(result.exitCode, 0);
});

test("sandboxed bash terminates the process group on timeout", async () => {
  const fake = createRuntime();
  const operations = createSandboxedBashOperations(
    fake.runtime,
    new SandboxProcessTracker(),
  );
  const startedAt = Date.now();

  await assert.rejects(
    operations.exec("sleep 5", process.cwd(), {
      onData() {},
      timeout: 0.05,
    }),
    /timeout:0.05/,
  );

  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(fake.cleanupCount(), 1);
});

test("sandboxed bash terminates the process group on cancellation", async () => {
  const fake = createRuntime();
  const operations = createSandboxedBashOperations(
    fake.runtime,
    new SandboxProcessTracker(),
  );
  const controller = new AbortController();
  const command = operations.exec("sleep 5", process.cwd(), {
    onData() {},
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(command, /aborted/);
  assert.equal(fake.cleanupCount(), 1);
});
