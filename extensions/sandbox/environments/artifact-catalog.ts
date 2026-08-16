import {
  installArchiveRuntime,
  installRawRuntime,
  type ArchiveRuntimeManifest,
  type RawRuntimeManifest,
  type RuntimeInstallerOptions,
} from "./installer.ts";
import { EnvironmentStore } from "./store.ts";
import type { EnvironmentId } from "./types.ts";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const PYTHON_STANDALONE_RELEASES: Readonly<Record<string, string>> = {
  "3.11.11": "20250212",
  "3.12.9": "20250212",
  "3.13.9": "20251014",
};

export type TrustedRuntimeManifest = ArchiveRuntimeManifest | RawRuntimeManifest;

export interface ArtifactCatalogOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

interface CatalogTarget {
  os: "darwin" | "linux";
  arch: "arm64" | "x64";
}

export async function resolveTrustedRuntimeManifest(
  profile: EnvironmentId,
  version: string,
  platform: string,
  options: ArtifactCatalogOptions = {},
): Promise<TrustedRuntimeManifest> {
  if (!EXACT_VERSION.test(version)) throw new Error(`Runtime version must be exact: ${JSON.stringify(version)}`);
  const target = catalogTarget(platform);
  switch (profile) {
    case "go": return resolveGo(version, platform, target, options);
    case "node": return resolveNode(version, platform, target, options);
    case "kubectl": return resolveKubectl(version, platform, target, options);
    case "pnpm": return resolvePnpm(version, platform, options);
    case "python": return resolvePython(version, platform, target, options);
  }
}

export async function installTrustedRuntime(
  store: EnvironmentStore,
  profile: EnvironmentId,
  version: string,
  platform: string,
  options: RuntimeInstallerOptions = {},
): Promise<string> {
  await store.initialize();
  const existing = await store.resolve(platform, profile, version);
  if (existing) return existing;
  const manifest = await resolveTrustedRuntimeManifest(profile, version, platform, options);
  return "format" in manifest
    ? installArchiveRuntime(store, manifest, options)
    : installRawRuntime(store, manifest, options);
}

async function resolveGo(
  version: string,
  platform: string,
  target: CatalogTarget,
  options: ArtifactCatalogOptions,
): Promise<ArchiveRuntimeManifest> {
  const raw = await fetchTrustedText(
    "https://go.dev/dl/?mode=json&include=all",
    new Set(["go.dev"]),
    options,
  );
  let releases: unknown;
  try {
    releases = JSON.parse(raw);
  } catch {
    throw new Error("Go release manifest is not valid JSON");
  }
  if (!Array.isArray(releases)) throw new Error("Go release manifest has an invalid shape");
  const release = releases.find((candidate) => isRecord(candidate) && candidate.version === `go${version}`);
  const files = isRecord(release) && Array.isArray(release.files) ? release.files : [];
  // go.dev names the x64 target amd64, while the catalog's internal platform
  // spelling follows Node.js (x64). Translate at this boundary only.
  const goArch = target.arch === "x64" ? "amd64" : target.arch;
  const filename = `go${version}.${target.os}-${goArch}.tar.gz`;
  const artifact = files.find((candidate) => (
    isRecord(candidate)
    && candidate.filename === filename
    && candidate.os === target.os
    && candidate.arch === goArch
    && candidate.kind === "archive"
  ));
  const sha256 = isRecord(artifact) ? artifact.sha256 : undefined;
  const size = isRecord(artifact) ? artifact.size : undefined;
  assertDigest(sha256, `Go ${version}`);
  if (!Number.isSafeInteger(size) || Number(size) <= 0) {
    throw new Error(`Go release manifest has an invalid size for ${version}`);
  }
  return {
    profile: "go",
    version,
    platform,
    url: `https://dl.google.com/go/${filename}`,
    sha256,
    size: Number(size),
    format: "tar.gz",
    stripComponents: 1,
    executable: "bin/go",
  };
}

async function resolveNode(
  version: string,
  platform: string,
  target: CatalogTarget,
  options: ArtifactCatalogOptions,
): Promise<ArchiveRuntimeManifest> {
  const filename = `node-v${version}-${target.os}-${target.arch}.tar.gz`;
  const raw = await fetchTrustedText(
    `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    new Set(["nodejs.org"]),
    options,
  );
  const matching = raw.split(/\r?\n/).filter((line) => line.trim().endsWith(`  ${filename}`));
  if (matching.length !== 1) throw new Error(`Node.js checksum manifest does not contain exactly one ${filename}`);
  const [sha256, listedFilename, extra] = matching[0].trim().split(/\s+/);
  assertDigest(sha256, `Node.js ${version}`);
  if (listedFilename !== filename || extra !== undefined) {
    throw new Error(`Node.js checksum manifest has an invalid entry for ${filename}`);
  }
  return {
    profile: "node",
    version,
    platform,
    url: `https://nodejs.org/dist/v${version}/${filename}`,
    sha256,
    format: "tar.gz",
    stripComponents: 1,
    executable: "bin/node",
  };
}

async function resolvePython(
  version: string,
  platform: string,
  target: CatalogTarget,
  options: ArtifactCatalogOptions,
): Promise<ArchiveRuntimeManifest> {
  const release = PYTHON_STANDALONE_RELEASES[version];
  if (!release) throw new Error(`Trusted relocatable Python release is not cataloged: ${version}`);
  const targetName = target.os === "darwin"
    ? `${target.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
    : `${target.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
  const filename = `cpython-${version}+${release}-${targetName}-install_only_stripped.tar.gz`;
  const base = `https://github.com/astral-sh/python-build-standalone/releases/download/${release}`;
  const artifactUrl = `${base}/${encodeURIComponent(filename)}`;
  const sha256 = (await fetchTrustedText(
    `${artifactUrl}.sha256`,
    new Set(["github.com", "release-assets.githubusercontent.com"]),
    options,
  )).trim();
  assertDigest(sha256, `Python ${version}`);
  return {
    profile: "python",
    version,
    platform,
    url: artifactUrl,
    sha256,
    trustedRedirectHosts: ["release-assets.githubusercontent.com"],
    format: "tar.gz",
    stripComponents: 1,
    executable: "bin/python",
  };
}

async function resolvePnpm(
  version: string,
  platform: string,
  options: ArtifactCatalogOptions,
): Promise<ArchiveRuntimeManifest> {
  const registryUrl = `https://registry.npmjs.org/pnpm/${version}`;
  const raw = await fetchTrustedText(registryUrl, new Set(["registry.npmjs.org"]), options);
  let metadata: unknown;
  try {
    metadata = JSON.parse(raw);
  } catch {
    throw new Error("pnpm registry manifest is not valid JSON");
  }
  if (!isRecord(metadata) || metadata.version !== version || !isRecord(metadata.dist)) {
    throw new Error(`pnpm registry manifest has an invalid shape for ${version}`);
  }
  const tarball = metadata.dist.tarball;
  const integrity = metadata.dist.integrity;
  if (typeof tarball !== "string" || typeof integrity !== "string") {
    throw new Error(`pnpm registry manifest is missing distribution integrity for ${version}`);
  }
  const artifactUrl = new URL(tarball);
  if (artifactUrl.protocol !== "https:" || artifactUrl.hostname !== "registry.npmjs.org") {
    throw new Error(`pnpm registry manifest contains an untrusted artifact URL: ${tarball}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`pnpm registry manifest has invalid SHA-512 integrity for ${version}`);
  }
  return {
    profile: "pnpm",
    version,
    platform,
    url: artifactUrl.href,
    integrity,
    format: "tar.gz",
    stripComponents: 1,
    extractTo: "lib/pnpm",
    archiveExecutable: "lib/pnpm/bin/pnpm.cjs",
    executable: "bin/pnpm",
    nodeLauncher: true,
  };
}

async function resolveKubectl(
  version: string,
  platform: string,
  target: CatalogTarget,
  options: ArtifactCatalogOptions,
): Promise<RawRuntimeManifest> {
  // dl.k8s.io uses amd64 for the x64 target (matching go.dev, not Node.js).
  const kubernetesArch = target.arch === "x64" ? "amd64" : target.arch;
  const base = `https://dl.k8s.io/release/v${version}/bin/${target.os}/${kubernetesArch}/kubectl`;
  const sha256 = (await fetchTrustedText(`${base}.sha256`, new Set(["dl.k8s.io"]), options)).trim();
  assertDigest(sha256, `kubectl ${version}`);
  return {
    profile: "kubectl",
    version,
    platform,
    url: base,
    sha256,
    executable: "kubectl",
  };
}

function catalogTarget(platform: string): CatalogTarget {
  switch (platform) {
    case "darwin-arm64": return { os: "darwin", arch: "arm64" };
    case "darwin-x64": return { os: "darwin", arch: "x64" };
    case "linux-arm64": return { os: "linux", arch: "arm64" };
    case "linux-x64": return { os: "linux", arch: "x64" };
    default: throw new Error(`Trusted runtime catalog does not support platform: ${platform}`);
  }
}

async function fetchTrustedText(
  url: string,
  trustedHosts: Set<string>,
  options: ArtifactCatalogOptions,
): Promise<string> {
  const response = await (options.fetch ?? fetch)(url, {
    redirect: "follow",
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Runtime manifest request failed with HTTP ${response.status}: ${url}`);
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== "https:" || !trustedHosts.has(finalUrl.hostname)) {
    throw new Error(`Runtime manifest redirected to an untrusted origin: ${finalUrl.href}`);
  }
  if (!response.body) throw new Error(`Runtime manifest returned no body: ${url}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
    throw new Error(`Runtime manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${url}`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_MANIFEST_BYTES) throw new Error(`Runtime manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${url}`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new Error(`${label} release manifest has an invalid SHA-256 digest`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
