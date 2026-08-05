import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export interface PathGrant {
  path: string;
  directory: boolean;
}

export class SandboxPathAuthorization {
  private workspace = "";
  private readonly grants = new Map<string, PathGrant>();

  async reset(cwd: string): Promise<void> {
    this.workspace = await canonicalExistingPath(cwd);
    this.grants.clear();
  }

  async inspect(
    rawPath: string,
    cwd: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<PathGrant> {
    const expanded = expandHome(stripAtPrefix(rawPath));
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    const path = await canonicalPotentialPath(absolute);
    try {
      const metadata = await stat(path);
      return { path, directory: metadata.isDirectory() };
    } catch (error) {
      if (!options.allowMissing || !isMissingPathError(error)) throw error;
      return { path, directory: false };
    }
  }

  grant(candidate: PathGrant): void {
    if (this.isWithinWorkspace(candidate.path)) return;
    this.grants.set(candidate.path, candidate);
  }

  revoke(): void {
    this.grants.clear();
  }

  async isAllowed(rawPath: string, cwd: string): Promise<boolean> {
    const expanded = expandHome(stripAtPrefix(rawPath));
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    const path = await canonicalPotentialPath(absolute);
    if (this.isWithinWorkspace(path)) return true;
    return [...this.grants.values()].some((grant) =>
      grant.directory ? isWithin(grant.path, path) : grant.path === path,
    );
  }

  paths(): string[] {
    return [...this.grants.keys()].sort();
  }

  private isWithinWorkspace(path: string): boolean {
    return this.workspace !== "" && isWithin(this.workspace, path);
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function canonicalExistingPath(path: string): Promise<string> {
  return realpath(path);
}

async function canonicalPotentialPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const canonicalParent = await realpath(current);
      return resolve(canonicalParent, ...missing.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}
