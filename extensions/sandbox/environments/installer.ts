import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { t as listTar, x as extractTar } from "tar";
import { EnvironmentStore } from "./store.ts";

const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._+/@-]+(?:\/[A-Za-z0-9._+@-]+)*$/;
const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_ENTRIES = 200_000;

interface RuntimeArtifactManifest {
  profile: string;
  version: string;
  platform: string;
  url: string;
  /** Trusted artifact SHA-256, when the upstream publishes one. */
  sha256?: string;
  /** Trusted Subresource Integrity value, currently restricted to SHA-512. */
  integrity?: string;
  /** Exact compressed artifact size when supplied by the official manifest. */
  size?: number;
  /** HTTPS redirect destinations explicitly trusted by the catalog. */
  trustedRedirectHosts?: string[];
}

export interface RawRuntimeManifest extends RuntimeArtifactManifest {
  executable: string;
}

export interface ArchiveRuntimeManifest extends RuntimeArtifactManifest {
  format: "tar.gz";
  /** Number of leading archive path components omitted during extraction. */
  stripComponents: number;
  /** Executable path after stripping and optional relocation. */
  executable: string;
  /** Object-relative directory that receives stripped archive contents. */
  extractTo?: string;
  /** Original object-relative executable path after extraction. */
  archiveExecutable?: string;
  /** Create a fixed Node.js launcher at executable instead of moving archiveExecutable. */
  nodeLauncher?: true;
}

export interface RuntimeInstallerOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  maxDownloadBytes?: number;
  maxExtractedBytes?: number;
  maxArchiveEntries?: number;
  archiveExtractor?: (request: {
    archivePath: string;
    destination: string;
    stripComponents: number;
  }) => Promise<void>;
  /** Unit/integration-test escape hatch; production installers remain HTTPS-only. */
  allowInsecureLocalhost?: boolean;
}

export async function installRawRuntime(
  store: EnvironmentStore,
  manifest: RawRuntimeManifest,
  options: RuntimeInstallerOptions = {},
): Promise<string> {
  validateArtifactManifest(manifest, options.allowInsecureLocalhost === true);
  if (!EXECUTABLE_NAME.test(manifest.executable)) {
    throw new Error(`Invalid runtime executable name: ${JSON.stringify(manifest.executable)}`);
  }
  const existing = await initializeAndResolve(store, manifest);
  if (existing) return existing;

  const stagingPath = await store.createStagingDirectory(manifest.profile);
  const downloadPath = join(stagingPath, "runtime.download");
  try {
    const digest = await downloadVerifiedArtifact(manifest, downloadPath, options);
    const binDirectory = join(stagingPath, "bin");
    await mkdir(binDirectory, { mode: 0o700 });
    const executablePath = join(binDirectory, manifest.executable);
    await rename(downloadPath, executablePath);
    await chmod(executablePath, 0o755);
    return await publish(store, manifest, stagingPath, digest);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function installArchiveRuntime(
  store: EnvironmentStore,
  manifest: ArchiveRuntimeManifest,
  options: RuntimeInstallerOptions = {},
): Promise<string> {
  validateArtifactManifest(manifest, options.allowInsecureLocalhost === true);
  validateArchiveManifest(manifest);
  const existing = await initializeAndResolve(store, manifest);
  if (existing) return existing;

  const stagingPath = await store.createStagingDirectory(manifest.profile);
  const downloadDirectory = await mkdtemp(join(tmpdir(), "pi-runtime-download-"));
  const archivePath = join(downloadDirectory, "runtime.tar.gz");
  try {
    const digest = await downloadVerifiedArtifact(manifest, archivePath, options);
    const extractionRoot = manifest.extractTo
      ? join(stagingPath, ...manifest.extractTo.split("/"))
      : stagingPath;
    await mkdir(extractionRoot, { recursive: true, mode: 0o700 });
    await extractVerifiedTarGz(archivePath, extractionRoot, manifest, options);
    await rm(archivePath, { force: true });
    const archiveExecutable = manifest.archiveExecutable ?? manifest.executable;
    const sourcePath = join(stagingPath, ...archiveExecutable.split("/"));
    const executablePath = join(stagingPath, ...manifest.executable.split("/"));
    try {
      await access(sourcePath);
    } catch {
      throw new Error(
        `Runtime archive is missing executable ${archiveExecutable}: ${manifest.profile}@${manifest.version}`,
      );
    }
    if (manifest.nodeLauncher) {
      await mkdir(dirname(executablePath), { recursive: true, mode: 0o700 });
      const relativeTarget = posix.relative(posix.dirname(manifest.executable), archiveExecutable);
      await writeFile(executablePath, [
        "#!/bin/sh",
        `exec node \"$(dirname \"$0\")/${relativeTarget}\" \"$@\"`,
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o755 });
    } else if (sourcePath !== executablePath) {
      await mkdir(dirname(executablePath), { recursive: true, mode: 0o700 });
      await rename(sourcePath, executablePath);
    }
    await chmod(executablePath, 0o755);
    return await publish(store, manifest, stagingPath, digest);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function initializeAndResolve(
  store: EnvironmentStore,
  manifest: RuntimeArtifactManifest,
): Promise<string | undefined> {
  await store.initialize();
  return store.resolve(manifest.platform, manifest.profile, manifest.version);
}

async function publish(
  store: EnvironmentStore,
  manifest: RuntimeArtifactManifest,
  stagingPath: string,
  digest: string,
): Promise<string> {
  return store.publish({
    stagingPath,
    digest,
    platform: manifest.platform,
    profile: manifest.profile,
    version: manifest.version,
  });
}

async function downloadVerifiedArtifact(
  manifest: RuntimeArtifactManifest,
  destination: string,
  options: RuntimeInstallerOptions,
): Promise<string> {
  const response = await (options.fetch ?? fetch)(manifest.url, {
    redirect: "follow",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Runtime download failed with HTTP ${response.status}: ${manifest.url}`);
  }
  const requestedUrl = new URL(manifest.url);
  const finalUrl = new URL(response.url || manifest.url);
  const trustedHosts = new Set([requestedUrl.hostname, ...(manifest.trustedRedirectHosts ?? [])]);
  if (finalUrl.protocol !== "https:" && !(options.allowInsecureLocalhost && finalUrl.protocol === "http:")) {
    throw new Error(`Runtime download redirected to a non-HTTPS origin: ${finalUrl.href}`);
  }
  if (!trustedHosts.has(finalUrl.hostname)) {
    throw new Error(`Runtime download redirected to an untrusted origin: ${finalUrl.href}`);
  }
  if (!response.body) throw new Error(`Runtime download returned no body: ${manifest.url}`);

  const limit = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`Runtime download exceeds ${limit} bytes: ${manifest.url}`);
  }

  const sha256 = createHash("sha256");
  const sha512 = manifest.integrity ? createHash("sha512") : undefined;
  const file = await open(destination, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) throw new Error(`Runtime download exceeds ${limit} bytes: ${manifest.url}`);
      sha256.update(buffer);
      sha512?.update(buffer);
      await file.write(buffer);
    }
  } finally {
    await file.close();
  }

  if (manifest.size !== undefined && bytes !== manifest.size) {
    throw new Error(
      `Runtime size mismatch for ${manifest.profile}@${manifest.version}: expected ${manifest.size}, received ${bytes}`,
    );
  }
  const actualDigest = sha256.digest("hex");
  if (manifest.sha256 && actualDigest !== manifest.sha256) {
    throw new Error(
      `Runtime SHA-256 mismatch for ${manifest.profile}@${manifest.version}: expected ${manifest.sha256}, received ${actualDigest}`,
    );
  }
  if (manifest.integrity) {
    const actualIntegrity = `sha512-${sha512!.digest("base64")}`;
    if (actualIntegrity !== manifest.integrity) {
      throw new Error(`Runtime integrity mismatch for ${manifest.profile}@${manifest.version}`);
    }
  }
  return actualDigest;
}

async function extractVerifiedTarGz(
  archivePath: string,
  destination: string,
  manifest: ArchiveRuntimeManifest,
  options: RuntimeInstallerOptions,
): Promise<void> {
  await validateTarGz(archivePath, manifest, options);
  if (options.archiveExtractor) {
    await options.archiveExtractor({
      archivePath,
      destination,
      stripComponents: manifest.stripComponents,
    });
    return;
  }
  await extractTar({
    file: archivePath,
    cwd: destination,
    gzip: true,
    strip: manifest.stripComponents,
    preservePaths: false,
    strict: true,
  });
}

async function validateTarGz(
  archivePath: string,
  manifest: ArchiveRuntimeManifest,
  options: RuntimeInstallerOptions,
): Promise<void> {
  const seen = new Set<string>();
  const symbolicLinks = new Set<string>();
  let entries = 0;
  let extractedBytes = 0;
  let validationError: Error | undefined;
  const entryLimit = options.maxArchiveEntries ?? DEFAULT_MAX_ARCHIVE_ENTRIES;
  const byteLimit = options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;

  await listTar({
    file: archivePath,
    gzip: true,
    strict: true,
    filter: (archivePathName, entry) => {
      if (validationError) return false;
      try {
        const outputPath = validateArchiveEntryPath(archivePathName, manifest.stripComponents);
        if (!outputPath) return false;
        entries += 1;
        if (entries > entryLimit) throw new Error(`Runtime archive exceeds ${entryLimit} entries`);
        const size = Number(entry.size ?? 0);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error(`Invalid archive entry size: ${archivePathName}`);
        }
        extractedBytes += size;
        if (extractedBytes > byteLimit) {
          throw new Error(`Runtime archive expands beyond ${byteLimit} bytes`);
        }
        validateArchiveEntryType(entry.type, archivePathName);
        assertNoSymbolicLinkAncestor(outputPath, symbolicLinks);
        if (seen.has(outputPath)) throw new Error(`Duplicate runtime archive path: ${archivePathName}`);
        seen.add(outputPath);
        if (entry.type === "SymbolicLink") {
          validateSymbolicLink(outputPath, entry.linkpath, archivePathName);
          for (const existing of seen) {
            if (existing.startsWith(`${outputPath}/`)) {
              throw new Error(`Runtime archive symlink replaces a directory: ${archivePathName}`);
            }
          }
          symbolicLinks.add(outputPath);
        } else if (entry.type === "Link") {
          validateHardLink(entry.linkpath, manifest.stripComponents, archivePathName);
        }
      } catch (error) {
        validationError = error instanceof Error ? error : new Error(String(error));
      }
      return false;
    },
  });
  if (validationError) throw validationError;
}

function validateArtifactManifest(
  manifest: RuntimeArtifactManifest,
  allowInsecureLocalhost: boolean,
): void {
  if (manifest.sha256 !== undefined && !SHA256_DIGEST.test(manifest.sha256)) {
    throw new Error(`Invalid runtime SHA-256 digest: ${JSON.stringify(manifest.sha256)}`);
  }
  if (manifest.integrity !== undefined && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.integrity)) {
    throw new Error(`Invalid runtime artifact integrity: ${JSON.stringify(manifest.integrity)}`);
  }
  if (!manifest.sha256 && !manifest.integrity) {
    throw new Error("Runtime artifact manifest requires a trusted SHA-256 or SHA-512 integrity value");
  }
  if (manifest.size !== undefined && (!Number.isSafeInteger(manifest.size) || manifest.size <= 0)) {
    throw new Error(`Invalid runtime artifact size: ${JSON.stringify(manifest.size)}`);
  }
  if (manifest.trustedRedirectHosts?.some((host) => !/^[A-Za-z0-9.-]+$/.test(host))) {
    throw new Error("Invalid trusted runtime redirect host");
  }
  let url: URL;
  try {
    url = new URL(manifest.url);
  } catch {
    throw new Error(`Invalid runtime URL: ${JSON.stringify(manifest.url)}`);
  }
  const insecureLocalhost = allowInsecureLocalhost
    && url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
  if (url.protocol !== "https:" && !insecureLocalhost) {
    throw new Error(`Runtime downloads require HTTPS: ${manifest.url}`);
  }
}

function validateArchiveManifest(manifest: ArchiveRuntimeManifest): void {
  if (manifest.format !== "tar.gz") throw new Error(`Unsupported runtime archive format: ${manifest.format}`);
  if (!Number.isInteger(manifest.stripComponents) || manifest.stripComponents < 0 || manifest.stripComponents > 8) {
    throw new Error(`Invalid runtime archive stripComponents: ${manifest.stripComponents}`);
  }
  if (
    !isSafeRelativePath(manifest.executable)
    || (manifest.extractTo !== undefined && !isSafeRelativePath(manifest.extractTo))
    || (manifest.archiveExecutable !== undefined && !isSafeRelativePath(manifest.archiveExecutable))
    || (manifest.nodeLauncher && !manifest.archiveExecutable)
  ) {
    throw new Error(`Invalid runtime executable path: ${JSON.stringify(manifest.executable)}`);
  }
}

function isSafeRelativePath(path: string): boolean {
  return SAFE_RELATIVE_PATH.test(path)
    && !path.startsWith("/")
    && !path.split("/").some((segment) => segment === "." || segment === "..");
}

function validateArchiveEntryPath(path: string, stripComponents: number): string | undefined {
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/")) {
    throw new Error(`Unsafe runtime archive path: ${JSON.stringify(path)}`);
  }
  const components = path.replace(/^\.\//, "").split("/").filter((segment) => segment !== "");
  if (components.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Unsafe runtime archive path: ${JSON.stringify(path)}`);
  }
  const output = components.slice(stripComponents);
  return output.length === 0 ? undefined : output.join("/");
}

function validateArchiveEntryType(type: string, path: string): void {
  if (!["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(type)) {
    throw new Error(`Unsupported runtime archive entry type ${type}: ${path}`);
  }
}

function assertNoSymbolicLinkAncestor(path: string, symbolicLinks: Set<string>): void {
  let parent = posix.dirname(path);
  while (parent !== "." && parent !== "/") {
    if (symbolicLinks.has(parent)) {
      throw new Error(`Runtime archive entry traverses a symbolic link: ${path}`);
    }
    parent = posix.dirname(parent);
  }
}

function validateSymbolicLink(outputPath: string, linkPath: string, archivePath: string): void {
  if (!linkPath || linkPath.startsWith("/") || linkPath.includes("\\") || linkPath.includes("\0")) {
    throw new Error(`Unsafe runtime archive symbolic link: ${archivePath}`);
  }
  const stack = dirname(outputPath).split("/").filter(Boolean);
  for (const segment of linkPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) throw new Error(`Runtime archive symbolic link escapes extraction: ${archivePath}`);
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
}

function validateHardLink(linkPath: string, stripComponents: number, archivePath: string): void {
  const target = validateArchiveEntryPath(linkPath, stripComponents);
  if (!target) throw new Error(`Unsafe runtime archive hard link: ${archivePath}`);
}
