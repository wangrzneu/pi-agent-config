import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { goCacheProfileFragment, resolveGoHostCacheRoots } from "./go-cache.ts";

async function tempHome() {
  const created = await mkdtemp(join(tmpdir(), "pi-go-cache-"));
  // Canonicalize once so expectations match the resolver's canonical paths on
  // platforms where the temp root itself contains a symlink (macOS /var).
  return realpathSync(created);
}

test("go cache roots follow Go's HOME-relative defaults", async () => {
  const home = await tempHome();
  assert.deepEqual(resolveGoHostCacheRoots({ HOME: home }, "linux"), {
    moduleCache: join(home, "go", "pkg", "mod"),
    buildCache: join(home, ".cache", "go-build"),
  });
  // Go ignores XDG_CACHE_HOME for os.UserCacheDir on macOS.
  assert.deepEqual(resolveGoHostCacheRoots({ HOME: home, XDG_CACHE_HOME: join(home, "xdg") }, "darwin"), {
    moduleCache: join(home, "go", "pkg", "mod"),
    buildCache: join(home, "Library", "Caches", "go-build"),
  });
});

test("go cache roots honor XDG_CACHE_HOME on Linux and explicit variables everywhere", async () => {
  const home = await tempHome();
  assert.equal(
    resolveGoHostCacheRoots({ HOME: home, XDG_CACHE_HOME: join(home, "xdg") }, "linux").buildCache,
    join(home, "xdg", "go-build"),
  );
  assert.deepEqual(resolveGoHostCacheRoots({
    HOME: home,
    GOPATH: join(home, "src", "go"),
    GOMODCACHE: join(home, "cache", "mod"),
    GOCACHE: join(home, "cache", "build"),
  }, "linux"), {
    moduleCache: join(home, "cache", "mod"),
    buildCache: join(home, "cache", "build"),
  });
});

test("the go cache fragment grants exactly the module and build caches", async () => {
  const home = await tempHome();
  const moduleCache = join(home, "go", "pkg", "mod");
  const buildCache = join(home, ".cache", "go-build");
  assert.deepEqual(goCacheProfileFragment({ HOME: home }, "linux"), {
    env: { GOMODCACHE: moduleCache, GOCACHE: buildCache },
    allowRead: [moduleCache, buildCache],
    allowWrite: [moduleCache, buildCache],
  });
});

test("unsafe cache roots fail closed", async () => {
  const home = await tempHome();
  assert.throws(
    () => resolveGoHostCacheRoots({ HOME: home, GOCACHE: "/" }, "linux"),
    /GOCACHE must not be the filesystem root/,
  );
  assert.throws(
    () => resolveGoHostCacheRoots({ HOME: home, GOMODCACHE: home }, "linux"),
    /GOMODCACHE must not be the filesystem root/,
  );
  assert.throws(
    () => resolveGoHostCacheRoots({ HOME: home, GOCACHE: dirname(home) }, "linux"),
    /GOCACHE must not be the filesystem root/,
  );
  assert.throws(
    () => resolveGoHostCacheRoots({ HOME: home, GOCACHE: "relative/cache" }, "linux"),
    /GOCACHE must be an absolute path/,
  );
});
