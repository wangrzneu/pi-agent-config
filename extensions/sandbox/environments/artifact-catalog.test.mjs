import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrustedRuntimeManifest } from "./artifact-catalog.ts";

const GO_DIGEST = "1".repeat(64);
const NODE_DIGEST = "2".repeat(64);
const KUBECTL_DIGEST = "3".repeat(64);
const PYTHON_DIGEST = "4".repeat(64);
const PNPM_INTEGRITY = `sha512-${Buffer.alloc(64, 4).toString("base64")}`;

function response(body, url) {
  const result = new Response(body, { status: 200 });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

test("trusted catalog resolves exact runtime artifacts across platforms and profiles", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.startsWith("https://go.dev/dl/")) {
      const file = (os, arch, size) => ({
        filename: `go1.26.6.${os}-${arch}.tar.gz`,
        os,
        arch,
        kind: "archive",
        sha256: GO_DIGEST,
        size,
      });
      return response(JSON.stringify([{
        version: "go1.26.6",
        stable: true,
        files: [
          file("linux", "arm64", 72_000_000),
          file("darwin", "arm64", 72_000_001),
          file("darwin", "amd64", 72_000_002),
          file("linux", "amd64", 72_000_003),
        ],
      }]), value);
    }
    if (value.endsWith("SHASUMS256.txt")) {
      return response(`${NODE_DIGEST}  node-v26.5.0-linux-arm64.tar.gz\n`, value);
    }
    if (value.endsWith("kubectl.sha256")) return response(`${KUBECTL_DIGEST}\n`, value);
    if (value.includes("python-build-standalone") && value.endsWith("/SHA256SUMS")) {
      const tag = value.split("/download/")[1].split("/SHA256SUMS")[0];
      const targets = [
        "aarch64-unknown-linux-gnu",
        "aarch64-apple-darwin",
        "x86_64-unknown-linux-gnu",
      ];
      const versions = tag === "20251014" ? ["3.13.9"] : ["3.11.11", "3.12.9"];
      const lines = versions.flatMap((version) => targets.map((target) => (
        `${PYTHON_DIGEST}  cpython-${version}+${tag}-${target}-install_only_stripped.tar.gz\n`
      )));
      return response(lines.join(""), value);
    }
    if (value.includes("registry.npmjs.org/pnpm/")) {
      return response(JSON.stringify({
        version: "10.33.0",
        dist: {
          tarball: "https://registry.npmjs.org/pnpm/-/pnpm-10.33.0.tgz",
          integrity: PNPM_INTEGRITY,
        },
      }), value);
    }
    throw new Error(`unexpected URL: ${value}`);
  };

  const goManifest = (platform, url, size) => ({
    profile: "go",
    version: "1.26.6",
    platform,
    url,
    sha256: GO_DIGEST,
    size,
    format: "tar.gz",
    stripComponents: 1,
    executable: "bin/go",
  });
  assert.deepEqual(
    await resolveTrustedRuntimeManifest("go", "1.26.6", "linux-arm64", { fetch: fetchImpl }),
    goManifest("linux-arm64", "https://dl.google.com/go/go1.26.6.linux-arm64.tar.gz", 72_000_000),
  );
  assert.deepEqual(
    await resolveTrustedRuntimeManifest("go", "1.26.6", "darwin-arm64", { fetch: fetchImpl }),
    goManifest("darwin-arm64", "https://dl.google.com/go/go1.26.6.darwin-arm64.tar.gz", 72_000_001),
  );
  // dl.google.com and go.dev spell the x64 target "amd64"; the catalog must
  // translate from its internal x64 platform spelling.
  assert.deepEqual(
    await resolveTrustedRuntimeManifest("go", "1.26.6", "darwin-x64", { fetch: fetchImpl }),
    goManifest("darwin-x64", "https://dl.google.com/go/go1.26.6.darwin-amd64.tar.gz", 72_000_002),
  );
  assert.deepEqual(
    await resolveTrustedRuntimeManifest("go", "1.26.6", "linux-x64", { fetch: fetchImpl }),
    goManifest("linux-x64", "https://dl.google.com/go/go1.26.6.linux-amd64.tar.gz", 72_000_003),
  );

  assert.equal(
    (await resolveTrustedRuntimeManifest("node", "26.5.0", "linux-arm64", { fetch: fetchImpl })).sha256,
    NODE_DIGEST,
  );

  assert.equal(
    (await resolveTrustedRuntimeManifest("kubectl", "1.32.3", "linux-arm64", { fetch: fetchImpl })).url,
    "https://dl.k8s.io/release/v1.32.3/bin/linux/arm64/kubectl",
  );
  // dl.k8s.io also uses amd64 for the x64 target.
  assert.equal(
    (await resolveTrustedRuntimeManifest("kubectl", "1.32.3", "linux-x64", { fetch: fetchImpl })).url,
    "https://dl.k8s.io/release/v1.32.3/bin/linux/amd64/kubectl",
  );

  assert.deepEqual(
    await resolveTrustedRuntimeManifest("python", "3.13.9", "linux-arm64", { fetch: fetchImpl }),
    {
      profile: "python",
      version: "3.13.9",
      platform: "linux-arm64",
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.13.9%2B20251014-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
      sha256: PYTHON_DIGEST,
      trustedRedirectHosts: ["release-assets.githubusercontent.com"],
      format: "tar.gz",
      stripComponents: 1,
      executable: "bin/python",
    },
  );
  for (const [version, targetSuffix] of [
    ["3.11.11", "aarch64-unknown-linux-gnu"],
    ["3.12.9", "aarch64-unknown-linux-gnu"],
  ]) {
    const manifest = await resolveTrustedRuntimeManifest("python", version, "linux-arm64", { fetch: fetchImpl });
    assert.equal(
      manifest.url,
      `https://github.com/astral-sh/python-build-standalone/releases/download/20250212/cpython-${version}%2B20250212-${targetSuffix}-install_only_stripped.tar.gz`,
    );
  }
  assert.equal(
    (await resolveTrustedRuntimeManifest("python", "3.13.9", "darwin-arm64", { fetch: fetchImpl })).url,
    "https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.13.9%2B20251014-aarch64-apple-darwin-install_only_stripped.tar.gz",
  );
  assert.equal(
    (await resolveTrustedRuntimeManifest("python", "3.13.9", "linux-x64", { fetch: fetchImpl })).url,
    "https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.13.9%2B20251014-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
  );

  assert.deepEqual(
    await resolveTrustedRuntimeManifest("pnpm", "10.33.0", "linux-arm64", { fetch: fetchImpl }),
    {
      profile: "pnpm",
      version: "10.33.0",
      platform: "linux-arm64",
      url: "https://registry.npmjs.org/pnpm/-/pnpm-10.33.0.tgz",
      integrity: PNPM_INTEGRITY,
      format: "tar.gz",
      stripComponents: 1,
      extractTo: "lib/pnpm",
      archiveExecutable: "lib/pnpm/bin/pnpm.cjs",
      executable: "bin/pnpm",
      nodeLauncher: true,
    },
  );
});

test("trusted catalog rejects ambiguous manifests, unsupported profiles, and origins", async () => {
  await assert.rejects(
    resolveTrustedRuntimeManifest("node", "latest", "linux-arm64"),
    /must be exact/,
  );
  await assert.rejects(
    resolveTrustedRuntimeManifest("go", "1.26.6", "windows-arm64"),
    /does not support platform/,
  );
  await assert.rejects(
    resolveTrustedRuntimeManifest("python", "3.12.0", "linux-arm64"),
    /not cataloged/,
  );
  await assert.rejects(resolveTrustedRuntimeManifest("node", "26.5.0", "linux-arm64", {
    fetch: async () => response(
      `${NODE_DIGEST}  node-v26.5.0-linux-arm64.tar.gz\n${NODE_DIGEST}  node-v26.5.0-linux-arm64.tar.gz\n`,
      "https://nodejs.org/dist/v26.5.0/SHASUMS256.txt",
    ),
  }), /exactly one/);
  await assert.rejects(resolveTrustedRuntimeManifest("kubectl", "1.32.3", "linux-arm64", {
    fetch: async () => response(KUBECTL_DIGEST, "https://attacker.example/kubectl.sha256"),
  }), /untrusted origin/);
});
