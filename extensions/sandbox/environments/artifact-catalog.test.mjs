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

test("trusted catalog resolves exact Go, Node.js, and kubectl Linux arm64 artifacts", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.startsWith("https://go.dev/dl/")) {
      return response(JSON.stringify([{
        version: "go1.24.2",
        stable: true,
        files: [
          {
            filename: "go1.24.2.linux-arm64.tar.gz",
            os: "linux",
            arch: "arm64",
            kind: "archive",
            sha256: GO_DIGEST,
            size: 72_000_000,
          },
          {
            filename: "go1.24.2.darwin-arm64.tar.gz",
            os: "darwin",
            arch: "arm64",
            kind: "archive",
            sha256: GO_DIGEST,
            size: 72_000_001,
          },
        ],
      }]), value);
    }
    if (value.endsWith("SHASUMS256.txt")) {
      return response(`${NODE_DIGEST}  node-v22.14.0-linux-arm64.tar.gz\n`, value);
    }
    if (value.endsWith("kubectl.sha256")) return response(`${KUBECTL_DIGEST}\n`, value);
    if (value.includes("python-build-standalone") && value.endsWith(".sha256")) {
      return response(`${PYTHON_DIGEST}\n`, value);
    }
    if (value.includes("registry.npmjs.org/pnpm/")) {
      return response(JSON.stringify({
        version: "10.6.0",
        dist: {
          tarball: "https://registry.npmjs.org/pnpm/-/pnpm-10.6.0.tgz",
          integrity: PNPM_INTEGRITY,
        },
      }), value);
    }
    throw new Error(`unexpected URL: ${value}`);
  };

  assert.deepEqual(await resolveTrustedRuntimeManifest("go", "1.24.2", "linux-arm64", { fetch: fetchImpl }), {
    profile: "go",
    version: "1.24.2",
    platform: "linux-arm64",
    url: "https://dl.google.com/go/go1.24.2.linux-arm64.tar.gz",
    sha256: GO_DIGEST,
    size: 72_000_000,
    format: "tar.gz",
    stripComponents: 1,
    executable: "bin/go",
  });
  assert.deepEqual(
    await resolveTrustedRuntimeManifest("go", "1.24.2", "darwin-arm64", { fetch: fetchImpl }),
    {
      profile: "go",
      version: "1.24.2",
      platform: "darwin-arm64",
      url: "https://dl.google.com/go/go1.24.2.darwin-arm64.tar.gz",
      sha256: GO_DIGEST,
      size: 72_000_001,
      format: "tar.gz",
      stripComponents: 1,
      executable: "bin/go",
    },
  );
  assert.equal(
    (await resolveTrustedRuntimeManifest("node", "22.14.0", "linux-arm64", { fetch: fetchImpl })).sha256,
    NODE_DIGEST,
  );
  assert.equal(
    (await resolveTrustedRuntimeManifest("kubectl", "1.32.3", "linux-arm64", { fetch: fetchImpl })).sha256,
    KUBECTL_DIGEST,
  );
  assert.deepEqual(
    await resolveTrustedRuntimeManifest("python", "3.13.2", "linux-arm64", { fetch: fetchImpl }),
    {
      profile: "python",
      version: "3.13.2",
      platform: "linux-arm64",
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20250212/cpython-3.13.2%2B20250212-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
      sha256: PYTHON_DIGEST,
      trustedRedirectHosts: ["release-assets.githubusercontent.com"],
      format: "tar.gz",
      stripComponents: 1,
      executable: "bin/python",
    },
  );
  assert.deepEqual(
    await resolveTrustedRuntimeManifest("pnpm", "10.6.0", "linux-arm64", { fetch: fetchImpl }),
    {
      profile: "pnpm",
      version: "10.6.0",
      platform: "linux-arm64",
      url: "https://registry.npmjs.org/pnpm/-/pnpm-10.6.0.tgz",
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
    resolveTrustedRuntimeManifest("go", "1.24.2", "windows-arm64"),
    /does not support platform/,
  );
  await assert.rejects(
    resolveTrustedRuntimeManifest("python", "3.12.0", "linux-arm64"),
    /not cataloged/,
  );
  await assert.rejects(resolveTrustedRuntimeManifest("node", "22.14.0", "linux-arm64", {
    fetch: async () => response(
      `${NODE_DIGEST}  node-v22.14.0-linux-arm64.tar.gz\n${NODE_DIGEST}  node-v22.14.0-linux-arm64.tar.gz\n`,
      "https://nodejs.org/dist/v22.14.0/SHASUMS256.txt",
    ),
  }), /exactly one/);
  await assert.rejects(resolveTrustedRuntimeManifest("kubectl", "1.32.3", "linux-arm64", {
    fetch: async () => response(KUBECTL_DIGEST, "https://attacker.example/kubectl.sha256"),
  }), /untrusted origin/);
});
