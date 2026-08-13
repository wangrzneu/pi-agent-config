import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  utimes,
} from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export interface WorkspaceChange {
  path: string;
  kind: "create" | "modify" | "delete";
  entryKind: EntryKind;
}

export interface WorkspacePolicy {
  allowWrite: string[];
  denyWrite: string[];
}

export interface TransactionalWorkspace {
  original: string;
  staged: string;
  root: string;
  baseline: Map<string, WorkspaceEntry>;
}

type EntryKind = "file" | "directory" | "symlink" | "other";

interface WorkspaceEntry {
  kind: EntryKind;
  mode: number;
  digest?: string;
  link?: string;
  mtimeMs: number;
}

const MANDATORY_DENY_PATTERNS = [
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".gitconfig",
  ".gitmodules",
  ".ripgreprc",
  ".mcp.json",
  "**/.vscode/**",
  "**/.idea/**",
  "**/.claude/commands/**",
  "**/.claude/agents/**",
  "**/.git/hooks/**",
  "**/.git/config",
];

export async function createTransactionalWorkspace(
  workspace: string,
  transactionRoot: string,
): Promise<TransactionalWorkspace> {
  const original = await realpath(workspace);
  await assertApfsPath(original);
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(transactionRoot, "command-"));
  const staged = join(root, "workspace");
  await mkdir(staged, { recursive: true, mode: 0o700 });
  await run("/bin/cp", ["-cR", `${original}${sep}.`, staged]);
  const baseline = await snapshotWorkspace(original);
  return { original, staged, root, baseline };
}

export async function discardTransactionalWorkspace(transaction: TransactionalWorkspace): Promise<void> {
  await rm(transaction.root, { recursive: true, force: true });
}

export async function reconcileTransactionalWorkspace(
  transaction: TransactionalWorkspace,
  policy: WorkspacePolicy,
): Promise<WorkspaceChange[]> {
  const currentOriginal = await snapshotWorkspace(transaction.original);
  const staged = await snapshotWorkspace(transaction.staged);
  assertUnchangedSinceClone(transaction.baseline, currentOriginal);
  const changes = diffSnapshots(transaction.baseline, staged);

  const denied = changes.filter((change) => !isWorkspaceChangeAllowed(change.path, transaction.original, policy));
  if (denied.length > 0) {
    throw new Error(
      `Sandboxed command changed protected path(s); no changes were committed:\n${denied.map((change) => change.path).join("\n")}`,
    );
  }

  if (changes.length === 0) return changes;
  await applyChangesWithRollback(transaction, changes, staged);
  return changes;
}

export function isWorkspaceChangeAllowed(
  relativePath: string,
  workspace: string,
  policy: WorkspacePolicy,
): boolean {
  const normalized = relativePath.split(sep).join("/");
  const absolute = resolve(workspace, relativePath);
  const writable = policy.allowWrite.some((entry) => {
    const allowed = resolvePolicyPath(entry, workspace);
    return absolute === allowed || absolute.startsWith(`${allowed}${sep}`);
  });
  if (!writable) return false;
  return ![...MANDATORY_DENY_PATTERNS, ...policy.denyWrite].some((pattern) =>
    matchesPolicyPattern(pattern, normalized, absolute, workspace)
  );
}

export async function assertApfsPath(path: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Transactional Apple Container workspaces require macOS APFS");
  }
  // Darwin's statfs f_type value for APFS is 26 (MOUNT_APFS). Checking the
  // filesystem before cloning prevents `cp -c` from silently becoming a full
  // workspace copy on a filesystem without clonefile support.
  const filesystem = await statfs(path);
  if (filesystem.type !== 26) {
    throw new Error(`Transactional Apple Container workspaces require APFS: ${path}`);
  }
}

async function snapshotWorkspace(root: string): Promise<Map<string, WorkspaceEntry>> {
  const entries = new Map<string, WorkspaceEntry>();

  const walk = async (directory: string, prefix: string): Promise<void> => {
    const handle = await opendir(directory);
    const names: string[] = [];
    for await (const entry of handle) names.push(entry.name);
    names.sort();

    for (const name of names) {
      const absolute = join(directory, name);
      const relativePath = prefix ? join(prefix, name) : name;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        entries.set(relativePath, {
          kind: "symlink",
          mode: stat.mode & 0o7777,
          link: await readlink(absolute),
          mtimeMs: stat.mtimeMs,
        });
      } else if (stat.isDirectory()) {
        entries.set(relativePath, {
          kind: "directory",
          mode: stat.mode & 0o7777,
          mtimeMs: stat.mtimeMs,
        });
        await walk(absolute, relativePath);
      } else if (stat.isFile()) {
        entries.set(relativePath, {
          kind: "file",
          mode: stat.mode & 0o7777,
          digest: await hashFile(absolute),
          mtimeMs: stat.mtimeMs,
        });
      } else {
        entries.set(relativePath, {
          kind: "other",
          mode: stat.mode & 0o7777,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };

  await walk(root, "");
  return entries;
}

function diffSnapshots(
  before: Map<string, WorkspaceEntry>,
  after: Map<string, WorkspaceEntry>,
): WorkspaceChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: WorkspaceChange[] = [];
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (!oldEntry && newEntry) {
      changes.push({ path, kind: "create", entryKind: newEntry.kind });
    } else if (oldEntry && !newEntry) {
      changes.push({ path, kind: "delete", entryKind: oldEntry.kind });
    } else if (oldEntry && newEntry && !entriesEqual(oldEntry, newEntry)) {
      changes.push({ path, kind: "modify", entryKind: newEntry.kind });
    }
  }
  return collapseDeletedTrees(changes);
}

function entriesEqual(left: WorkspaceEntry, right: WorkspaceEntry): boolean {
  return left.kind === right.kind && left.mode === right.mode && left.digest === right.digest && left.link === right.link;
}

function assertUnchangedSinceClone(
  baseline: Map<string, WorkspaceEntry>,
  current: Map<string, WorkspaceEntry>,
): void {
  const concurrent = diffSnapshots(baseline, current);
  if (concurrent.length > 0) {
    throw new Error(
      `Workspace changed concurrently while the container command was running; no changes were committed:\n${concurrent.map((change) => change.path).join("\n")}`,
    );
  }
}

function collapseDeletedTrees(changes: WorkspaceChange[]): WorkspaceChange[] {
  const deletedDirectories = changes
    .filter((change) => change.kind === "delete" && change.entryKind === "directory")
    .map((change) => change.path);
  return changes.filter((change) =>
    !deletedDirectories.some((directory) => change.path !== directory && change.path.startsWith(`${directory}${sep}`))
  );
}

async function applyChangesWithRollback(
  transaction: TransactionalWorkspace,
  changes: WorkspaceChange[],
  stagedSnapshot: Map<string, WorkspaceEntry>,
): Promise<void> {
  const rollbackRoot = join(transaction.root, "rollback");
  await mkdir(rollbackRoot, { recursive: true, mode: 0o700 });
  const journal: Array<{ target: string; backup?: string }> = [];
  const ordered = orderChanges(changes);

  try {
    for (const [index, change] of ordered.entries()) {
      const target = join(transaction.original, change.path);
      const source = join(transaction.staged, change.path);
      const backup = join(rollbackRoot, `${String(index).padStart(6, "0")}-${randomUUID()}`);
      let hasBackup = false;
      try {
        await lstat(target);
        await run("/bin/cp", ["-cR", target, backup]);
        hasBackup = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      journal.push({ target, backup: hasBackup ? backup : undefined });
      await applyOneChange(change, source, target, stagedSnapshot.get(change.path));
    }
  } catch (error) {
    for (const item of journal.reverse()) {
      await rm(item.target, { recursive: true, force: true }).catch(() => undefined);
      if (item.backup) {
        await mkdir(dirname(item.target), { recursive: true });
        await rename(item.backup, item.target).catch(async () => {
          await run("/bin/cp", ["-cR", item.backup!, item.target]);
        });
      }
    }
    throw error;
  }
}

function orderChanges(changes: WorkspaceChange[]): WorkspaceChange[] {
  const deletes = changes
    .filter((change) => change.kind === "delete")
    .sort((a, b) => b.path.split(sep).length - a.path.split(sep).length);
  const directories = changes
    .filter((change) => change.kind !== "delete" && change.entryKind === "directory")
    .sort((a, b) => a.path.split(sep).length - b.path.split(sep).length);
  const remaining = changes.filter((change) => change.kind !== "delete" && change.entryKind !== "directory");
  return [...deletes, ...directories, ...remaining];
}

async function applyOneChange(
  change: WorkspaceChange,
  source: string,
  target: string,
  entry: WorkspaceEntry | undefined,
): Promise<void> {
  if (change.kind === "delete") {
    await rm(target, { recursive: true, force: true });
    return;
  }
  if (!entry || entry.kind === "other") {
    throw new Error(`Unsupported workspace entry produced by sandboxed command: ${change.path}`);
  }

  await mkdir(dirname(target), { recursive: true });
  const existing = await lstat(target).catch(() => undefined);
  if (existing && kindOf(existing) !== entry.kind) await rm(target, { recursive: true, force: true });

  if (entry.kind === "directory") {
    await mkdir(target, { recursive: true, mode: entry.mode });
    await chmod(target, entry.mode);
    return;
  }
  if (entry.kind === "symlink") {
    await rm(target, { recursive: true, force: true });
    await symlink(entry.link!, target);
    return;
  }

  const temporary = `${target}.pi-sandbox-${randomUUID()}`;
  await copyFile(source, temporary, fsConstants.COPYFILE_FICLONE);
  await chmod(temporary, entry.mode);
  const sourceStat = await lstat(source);
  await utimes(temporary, sourceStat.atime, sourceStat.mtime);
  await rename(temporary, target);
}

function kindOf(stat: Awaited<ReturnType<typeof lstat>>): EntryKind {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function resolvePolicyPath(entry: string, workspace: string): string {
  if (entry === ".") return resolve(workspace);
  if (entry.startsWith("~/")) return resolve(process.env.HOME ?? tmpdir(), entry.slice(2));
  return isAbsolute(entry) ? resolve(entry) : resolve(workspace, entry);
}

function matchesPolicyPattern(pattern: string, relativePath: string, absolutePath: string, workspace: string): boolean {
  const normalizedPattern = pattern.split(sep).join("/");
  if (isAbsolute(pattern)) return safeMatchesGlob(absolutePath, normalizedPattern) || absolutePath === pattern;
  const workspaceRelativePattern = relative(workspace, resolve(workspace, pattern)).split(sep).join("/");
  if (normalizedPattern.includes("/")) {
    return safeMatchesGlob(relativePath, normalizedPattern) || safeMatchesGlob(relativePath, workspaceRelativePattern);
  }
  return basename(relativePath) === normalizedPattern || safeMatchesGlob(basename(relativePath), normalizedPattern);
}

function safeMatchesGlob(path: string, pattern: string): boolean {
  try {
    return matchesGlob(path, pattern);
  } catch {
    return path === pattern;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
