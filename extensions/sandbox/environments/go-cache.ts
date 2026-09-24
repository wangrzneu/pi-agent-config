import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface GoHostCacheRoots {
  /** Effective `GOMODCACHE` (`$GOPATH/pkg/mod` by default). */
  moduleCache: string;
  /** Effective `GOCACHE` (`os.UserCacheDir()/go-build`). */
  buildCache: string;
}

export interface GoCacheProfileFragment {
  env: Record<string, string>;
  allowRead: string[];
  allowWrite: string[];
}

/** Thrown when a host Go cache root would widen the sandbox unsafely. */
export class UnsafeGoCacheRootError extends Error {}

/**
 * Cache environment and sandbox grants a selected `go` profile adds: the host
 * module cache and build cache. `GOPATH` stays sandbox-owned so `go install`
 * keeps writing `$GOPATH/bin` into scratch instead of the user's home.
 */
export function goCacheProfileFragment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): GoCacheProfileFragment {
  const roots = resolveGoHostCacheRoots(env, platform);
  const allowWrite = [roots.moduleCache, roots.buildCache];
  return {
    env: { GOMODCACHE: roots.moduleCache, GOCACHE: roots.buildCache },
    allowRead: [...allowWrite],
    allowWrite,
  };
}

/**
 * Resolve the host Go cache roots for a selected `go` profile.
 *
 * Values mirror `go env` with `GOENV=off`: environment variables first, then
 * Go's platform defaults. `go env -w` (the `GOENV` file) is intentionally not
 * consulted, because the sandboxed child also runs with `GOENV=off` — both
 * sides agree even when a user configured a custom cache location.
 *
 * Roots are canonicalized against their existing prefix so the grant and the
 * env value match the path the OS resolves, and unsafe values (a relative
 * path, `/`, the home directory, or one of its ancestors) fail closed instead
 * of handing the sandbox a home-wide write grant.
 */
export function resolveGoHostCacheRoots(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): GoHostCacheRoots {
  const home = env.HOME?.trim() || homedir();
  const gopath = env.GOPATH?.trim() || join(home, "go");
  const moduleCache = env.GOMODCACHE?.trim() || join(gopath, "pkg", "mod");
  const buildCache = env.GOCACHE?.trim() || join(osCacheDirectory(env, platform, home), "go-build");
  return {
    moduleCache: safeCacheRoot(moduleCache, home, "GOMODCACHE"),
    buildCache: safeCacheRoot(buildCache, home, "GOCACHE"),
  };
}

function safeCacheRoot(root: string, home: string, label: string): string {
  if (!isAbsolute(root)) {
    throw new Error(`${label} must be an absolute path: ${root}`);
  }
  const canonical = canonicalizeExistingPrefix(resolve(root));
  const canonicalHome = canonicalizeExistingPrefix(resolve(home));
  const homePrefix = canonical.endsWith(sep) ? canonical : `${canonical}${sep}`;
  if (canonicalHome === canonical || canonicalHome.startsWith(homePrefix)) {
    throw new UnsafeGoCacheRootError(
      `${label} must not be the filesystem root, the home directory, or one of its ancestors: ${root}`,
    );
  }
  return canonical;
}

function canonicalizeExistingPrefix(path: string): string {
  const normalized = resolve(path);
  const segments: string[] = [];
  let current = normalized;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return normalized;
    segments.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...segments);
}

function osCacheDirectory(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string {
  if (platform === "darwin") return join(home, "Library", "Caches");
  const xdgCacheHome = env.XDG_CACHE_HOME?.trim();
  return xdgCacheHome || join(home, ".cache");
}
