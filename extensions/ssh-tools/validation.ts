import { isAbsolute, relative, resolve } from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";

export function validateHost(host: string): void {
  if (host.startsWith("-") || !/^[A-Za-z0-9_.:@%+\-[\]]+$/.test(host)) {
    throw new Error("SSH host must be a safe SSH config alias or user@host destination.");
  }
}

export function validateRemotePath(path: string): void {
  if (/[\r\n\0]/.test(path)) throw new Error("Remote path must be a single line without NUL bytes.");
}

export function workspacePath(cwd: string, input: string): string {
  const root = resolve(cwd);
  const candidate = resolve(root, input);
  const child = relative(root, candidate);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (child === ".." || child.startsWith(`..${separator}`) || isAbsolute(child)) {
    throw new Error("Local transfer paths must stay inside the current workspace.");
  }
  return candidate;
}

export async function workspaceUploadPath(cwd: string, input: string): Promise<string> {
  const candidate = workspacePath(cwd, input);
  const [root, source] = await Promise.all([realpath(cwd), realpath(candidate)]);
  assertInside(root, source);
  return source;
}

export async function workspaceDownloadPath(cwd: string, input: string): Promise<string> {
  const candidate = workspacePath(cwd, input);
  const root = await realpath(cwd);
  const parent = dirname(candidate);
  const ancestor = await nearestExistingAncestor(parent);
  assertInside(root, await realpath(ancestor));
  await mkdir(parent, { recursive: true });
  assertInside(root, await realpath(parent));
  return candidate;
}

function assertInside(root: string, candidate: string): void {
  const child = relative(root, candidate);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (child === ".." || child.startsWith(`..${separator}`) || isAbsolute(child)) {
    throw new Error("Local transfer paths must stay inside the current workspace.");
  }
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
