import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;

export interface InstalledEnvironmentObject {
  platform: string;
  profile: string;
  version: string;
  digest: string;
  bytes: number;
  leased: boolean;
  lastUsed: Date;
}

export interface EnvironmentStoreStatus {
  objects: number;
  bytes: number;
  leasedObjects: number;
  installed: InstalledEnvironmentObject[];
}

export interface EnvironmentPruneOptions {
  maxBytes: number;
  retentionDays: number;
  now?: Date;
}

export interface EnvironmentPruneResult {
  bytesBefore: number;
  bytesAfter: number;
  removedDigests: string[];
}

export interface PublishEnvironmentObject {
  stagingPath: string;
  digest: string;
  platform: string;
  profile: string;
  version: string;
}

export class EnvironmentStore {
  readonly root: string;
  private readonly objectsRoot: string;
  private readonly refsRoot: string;
  private readonly stagingRoot: string;
  private readonly leasesRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.objectsRoot = join(this.root, "toolchains", "objects", "sha256");
    this.refsRoot = join(this.root, "toolchains", "refs");
    this.stagingRoot = join(this.root, "staging");
    this.leasesRoot = join(this.root, "leases");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.objectsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.refsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.stagingRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.leasesRoot, { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, "environments"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, "package-cache"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, "locks"), { recursive: true, mode: 0o700 }),
    ]);
  }

  async createStagingDirectory(profile: string): Promise<string> {
    validateSegment("profile", profile);
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    return mkdtemp(join(this.stagingRoot, `${profile}-`));
  }

  async publish(input: PublishEnvironmentObject): Promise<string> {
    validateDigest(input.digest);
    validateSegment("platform", input.platform);
    validateSegment("profile", input.profile);
    validateSegment("version", input.version);
    assertInside(this.stagingRoot, input.stagingPath, "staging path");

    const objectPath = join(this.objectsRoot, input.digest);
    await mkdir(this.objectsRoot, { recursive: true, mode: 0o700 });
    if (await exists(objectPath)) {
      await rm(input.stagingPath, { recursive: true, force: true });
    } else {
      try {
        await rename(input.stagingPath, objectPath);
      } catch (error) {
        if (!(await exists(objectPath))) throw error;
        await rm(input.stagingPath, { recursive: true, force: true });
      }
    }
    await makeTreeReadOnly(objectPath);

    const refPath = this.referencePath(input.platform, input.profile, input.version);
    await mkdir(resolve(refPath, ".."), { recursive: true, mode: 0o700 });
    const temporaryRef = `${refPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryRef, `${JSON.stringify({ digest: input.digest })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryRef, refPath);
    return objectPath;
  }

  async resolve(
    platform: string,
    profile: string,
    version: string,
  ): Promise<string | undefined> {
    const refPath = this.referencePath(platform, profile, version);
    let raw: string;
    try {
      raw = await readFile(refPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid environment reference: ${refPath}`);
    }
    const digest = typeof parsed === "object" && parsed !== null && "digest" in parsed
      ? (parsed as { digest?: unknown }).digest
      : undefined;
    if (typeof digest !== "string") throw new Error(`Invalid environment reference: ${refPath}`);
    validateDigest(digest);
    const objectPath = join(this.objectsRoot, digest);
    if (!await exists(objectPath)) return undefined;
    const now = new Date();
    await utimes(refPath, now, now).catch(() => undefined);
    return objectPath;
  }

  async status(): Promise<EnvironmentStoreStatus> {
    await this.initialize();
    const [references, leasedDigests, objects] = await Promise.all([
      this.readReferences(),
      this.readActiveLeaseDigests(),
      this.readObjects(),
    ]);
    const objectsByDigest = new Map(objects.map((object) => [object.digest, object]));
    const installed: InstalledEnvironmentObject[] = [];
    for (const reference of references) {
      const relativePath = relative(this.refsRoot, reference.path);
      const segments = relativePath.split(/[\\/]/);
      if (segments.length !== 3 || !segments[2].endsWith(".json")) continue;
      const [platform, profile, versionFile] = segments;
      const version = versionFile.slice(0, -".json".length);
      try {
        validateSegment("platform", platform);
        validateSegment("profile", profile);
        validateSegment("version", version);
      } catch {
        continue;
      }
      const object = objectsByDigest.get(reference.digest);
      if (!object) continue;
      installed.push({
        platform,
        profile,
        version,
        digest: reference.digest,
        bytes: object.bytes,
        leased: leasedDigests.has(reference.digest),
        lastUsed: new Date(Math.max(reference.mtimeMs, object.mtimeMs)),
      });
    }
    installed.sort((left, right) => (
      left.platform.localeCompare(right.platform)
      || left.profile.localeCompare(right.profile)
      || left.version.localeCompare(right.version)
    ));
    return {
      objects: objects.length,
      bytes: objects.reduce((sum, object) => sum + object.bytes, 0),
      leasedObjects: objects.filter((object) => leasedDigests.has(object.digest)).length,
      installed,
    };
  }

  async acquireLease(
    leaseId: string,
    platform: string,
    profile: string,
    version: string,
  ): Promise<string> {
    const objectPath = await this.resolve(platform, profile, version);
    if (!objectPath) throw new Error(`${profile}@${version} for ${platform} cannot be leased because it is not installed`);
    const digest = basename(objectPath);
    validateDigest(digest);
    const leaseDirectory = this.leaseDirectory(leaseId);
    await mkdir(leaseDirectory, { recursive: true, mode: 0o700 });
    const leasePath = join(leaseDirectory, `${digest}.json`);
    const temporary = `${leasePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ digest, pid: process.pid })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, leasePath);
    return objectPath;
  }

  async releaseLease(leaseId: string): Promise<void> {
    await rm(this.leaseDirectory(leaseId), { recursive: true, force: true });
  }

  async prune(options: EnvironmentPruneOptions): Promise<EnvironmentPruneResult> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new Error(`Invalid environment-store maxBytes: ${options.maxBytes}`);
    }
    if (!Number.isFinite(options.retentionDays) || options.retentionDays < 0) {
      throw new Error(`Invalid environment-store retentionDays: ${options.retentionDays}`);
    }
    await this.initialize();
    const [references, leasedDigests, objects] = await Promise.all([
      this.readReferences(),
      this.readActiveLeaseDigests(),
      this.readObjects(),
    ]);
    const referencesByDigest = new Map<string, Array<{ path: string; mtimeMs: number }>>();
    for (const reference of references) {
      const list = referencesByDigest.get(reference.digest) ?? [];
      list.push({ path: reference.path, mtimeMs: reference.mtimeMs });
      referencesByDigest.set(reference.digest, list);
    }
    const bytesBefore = objects.reduce((sum, object) => sum + object.bytes, 0);
    let bytesAfter = bytesBefore;
    const cutoff = (options.now ?? new Date()).getTime() - options.retentionDays * 86_400_000;
    const candidates = objects
      .filter((object) => !leasedDigests.has(object.digest))
      .map((object) => ({
        ...object,
        lastUsed: Math.max(
          object.mtimeMs,
          ...(referencesByDigest.get(object.digest) ?? []).map((reference) => reference.mtimeMs),
        ),
      }))
      .sort((left, right) => left.lastUsed - right.lastUsed || left.digest.localeCompare(right.digest));
    const removedDigests: string[] = [];
    for (const candidate of candidates) {
      if (candidate.lastUsed >= cutoff && bytesAfter <= options.maxBytes) continue;
      await removeReadOnlyTree(candidate.path);
      for (const reference of referencesByDigest.get(candidate.digest) ?? []) {
        await rm(reference.path, { force: true });
      }
      bytesAfter -= candidate.bytes;
      removedDigests.push(candidate.digest);
    }
    return { bytesBefore, bytesAfter, removedDigests };
  }

  private async readReferences(): Promise<Array<{ path: string; digest: string; mtimeMs: number }>> {
    const references: Array<{ path: string; digest: string; mtimeMs: number }> = [];
    for (const path of await filesBelow(this.refsRoot)) {
      if (!path.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as { digest?: unknown };
        if (typeof parsed.digest !== "string") continue;
        validateDigest(parsed.digest);
        references.push({ path, digest: parsed.digest, mtimeMs: (await stat(path)).mtimeMs });
      } catch {
        // Invalid references are ignored here; resolve() still reports them.
      }
    }
    return references;
  }

  private async readActiveLeaseDigests(): Promise<Set<string>> {
    const active = new Set<string>();
    for (const path of await filesBelow(this.leasesRoot)) {
      if (!path.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as { digest?: unknown; pid?: unknown };
        if (typeof parsed.digest !== "string" || !Number.isSafeInteger(parsed.pid)) throw new Error("invalid lease");
        validateDigest(parsed.digest);
        if (isProcessAlive(Number(parsed.pid))) active.add(parsed.digest);
        else await rm(path, { force: true });
      } catch {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
    return active;
  }

  private async readObjects(): Promise<Array<{ digest: string; path: string; bytes: number; mtimeMs: number }>> {
    const objects: Array<{ digest: string; path: string; bytes: number; mtimeMs: number }> = [];
    for (const entry of await readdir(this.objectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SHA256_DIGEST.test(entry.name)) continue;
      const path = join(this.objectsRoot, entry.name);
      objects.push({
        digest: entry.name,
        path,
        bytes: await treeBytes(path),
        mtimeMs: (await stat(path)).mtimeMs,
      });
    }
    return objects;
  }

  private leaseDirectory(leaseId: string): string {
    if (!leaseId || /[\0\r\n]/.test(leaseId)) throw new Error("Invalid environment lease id");
    const key = createHash("sha256").update(leaseId).digest("hex");
    return join(this.leasesRoot, key);
  }

  private referencePath(platform: string, profile: string, version: string): string {
    validateSegment("platform", platform);
    validateSegment("profile", profile);
    validateSegment("version", version);
    return join(this.refsRoot, platform, profile, `${version}.json`);
  }
}

async function filesBelow(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function treeBytes(path: string): Promise<number> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return metadata.size;
  let total = metadata.size;
  for (const entry of await readdir(path)) total += await treeBytes(join(path, entry));
  return total;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

async function removeReadOnlyTree(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isSymbolicLink() && metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await removeReadOnlyTree(join(path, entry));
  } else if (!metadata.isSymbolicLink()) {
    await chmod(path, metadata.mode | 0o600);
  }
  await rm(path, { recursive: true, force: true });
}

async function makeTreeReadOnly(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) await makeTreeReadOnly(join(path, entry));
    await chmod(path, 0o555);
    return;
  }
  await chmod(path, metadata.mode & ~0o222);
}

export function parseEnvironmentStoreSize(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(b|k|kb|kib|m|mb|mib|g|gb|gib|t|tb|tib)$/);
  if (!match) throw new Error(`Invalid environment-store size: ${JSON.stringify(value)}`);
  const powers: Record<string, number> = {
    b: 0,
    k: 1, kb: 1, kib: 1,
    m: 2, mb: 2, mib: 2,
    g: 3, gb: 3, gib: 3,
    t: 4, tb: 4, tib: 4,
  };
  const bytes = Number(match[1]) * 1024 ** powers[match[2]];
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Invalid environment-store size: ${JSON.stringify(value)}`);
  }
  return bytes;
}

function validateDigest(digest: string): void {
  if (!SHA256_DIGEST.test(digest)) throw new Error(`Invalid SHA-256 digest: ${JSON.stringify(digest)}`);
}

function validateSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
}

function assertInside(root: string, candidate: string, label: string): void {
  const relation = relative(resolve(root), resolve(candidate));
  if (relation === "" || relation.startsWith("..") || relation.startsWith("/")) {
    throw new Error(`Invalid ${label}: ${candidate}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
