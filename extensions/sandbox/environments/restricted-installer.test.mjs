import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { c as createTar } from "tar";
import { createRestrictedArchiveExtractor } from "./restricted-installer.ts";

test("restricted archive extractor asks the sandbox runtime for no-network, destination-only writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-restricted-installer-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const archivePath = join(root, "runtime.tar.gz");
  await mkdir(join(source, "runtime", "bin"), { recursive: true });
  await mkdir(destination);
  await writeFile(join(source, "runtime", "bin", "tool"), "runtime");
  await createTar({ cwd: source, file: archivePath, gzip: true }, ["runtime"]);

  let customConfig;
  let cleanups = 0;
  const extractor = createRestrictedArchiveExtractor({
    async wrapWithSandbox(command, _shell, config) {
      customConfig = config;
      return command;
    },
    cleanupAfterCommand() { cleanups += 1; },
  });
  await extractor({ archivePath, destination, stripComponents: 1 });

  assert.equal(await readFile(join(destination, "bin", "tool"), "utf8"), "runtime");
  const canonicalDestination = await realpath(destination);
  assert.deepEqual(customConfig.network, { allowedDomains: [], deniedDomains: ["*"] });
  assert.deepEqual(customConfig.filesystem.allowWrite, [canonicalDestination]);
  assert.deepEqual(customConfig.filesystem.denyWrite, [process.cwd()]);
  assert.equal(cleanups, 1);
});
