import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { installArchiveRuntime, installRawRuntime } from "./installer.ts";
import { EnvironmentStore } from "./store.ts";

async function withServer(body, callback) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-length": String(body.length) });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}/runtime`);
  } finally {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}

test("raw runtime installer downloads, verifies, publishes, and reuses an object", async () => {
  const body = Buffer.from("#!/bin/sh\nprintf 'kubectl fixture\\n'\n");
  const digest = createHash("sha256").update(body).digest("hex");
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-installer-"));
  const store = new EnvironmentStore(root);
  let requests = 0;

  await withServer(body, async (url) => {
    const fetchImpl = async (...args) => {
      requests += 1;
      return fetch(...args);
    };
    const manifest = {
      profile: "kubectl",
      version: "1.32.3",
      platform: "linux-arm64",
      url,
      sha256: digest,
      executable: "kubectl",
    };
    const installed = await installRawRuntime(store, manifest, {
      allowInsecureLocalhost: true,
      fetch: fetchImpl,
    });
    assert.equal(await readFile(join(installed, "bin", "kubectl"), "utf8"), body.toString());

    const reused = await installRawRuntime(store, manifest, {
      allowInsecureLocalhost: true,
      fetch: fetchImpl,
    });
    assert.equal(reused, installed);
  });

  assert.equal(requests, 1, "an existing exact reference avoids another download");
});

test("archive runtime installer safely extracts, publishes, and reuses tar.gz artifacts", async () => {
  const body = tarGz([
    { name: "go/", type: "5", mode: 0o755 },
    { name: "go/bin/", type: "5", mode: 0o755 },
    { name: "go/bin/go", body: Buffer.from("#!/bin/sh\nprintf 'go fixture\\n'\n"), mode: 0o755 },
  ]);
  const digest = createHash("sha256").update(body).digest("hex");
  const root = await mkdtemp(join(tmpdir(), "pi-archive-installer-"));
  const store = new EnvironmentStore(root);
  let requests = 0;

  await withServer(body, async (url) => {
    const manifest = {
      profile: "go",
      version: "1.24.2",
      platform: "linux-arm64",
      url,
      sha256: digest,
      format: "tar.gz",
      stripComponents: 1,
      executable: "bin/go",
    };
    const fetchImpl = async (...args) => {
      requests += 1;
      return fetch(...args);
    };
    const installed = await installArchiveRuntime(store, manifest, {
      allowInsecureLocalhost: true,
      fetch: fetchImpl,
    });
    assert.match(await readFile(join(installed, "bin", "go"), "utf8"), /go fixture/);
    await assert.rejects(access(join(installed, "runtime.tar.gz")), /ENOENT/);
    assert.equal(await installArchiveRuntime(store, manifest, {
      allowInsecureLocalhost: true,
      fetch: fetchImpl,
    }), installed);
  });
  assert.equal(requests, 1);
});

test("archive installer verifies SHA-512 integrity and relocates standalone executables", async () => {
  const body = tarGz([
    { name: "package/", type: "5", mode: 0o755 },
    { name: "package/bin/", type: "5", mode: 0o755 },
    { name: "package/bin/pnpm.cjs", body: Buffer.from("console.log('10.6.0')\n"), mode: 0o644 },
  ]);
  const root = await mkdtemp(join(tmpdir(), "pi-archive-sri-"));
  await withServer(body, async (url) => {
    const installed = await installArchiveRuntime(new EnvironmentStore(root), {
      profile: "pnpm",
      version: "10.6.0",
      platform: "linux-arm64",
      url,
      integrity: `sha512-${createHash("sha512").update(body).digest("base64")}`,
      format: "tar.gz",
      stripComponents: 1,
      extractTo: "lib/pnpm",
      archiveExecutable: "lib/pnpm/bin/pnpm.cjs",
      executable: "bin/pnpm",
      nodeLauncher: true,
    }, { allowInsecureLocalhost: true });
    assert.match(await readFile(join(installed, "bin", "pnpm"), "utf8"), /node.*lib\/pnpm\/bin\/pnpm\.cjs/);
    assert.match(await readFile(join(installed, "lib", "pnpm", "bin", "pnpm.cjs"), "utf8"), /10\.6\.0/);
    assert.equal(installed.endsWith(createHash("sha256").update(body).digest("hex")), true);
  });
});

test("archive runtime installer rejects traversal and escaping symbolic links", async () => {
  const fixtures = [
    tarGz([
      { name: "tool/", type: "5", mode: 0o755 },
      { name: "tool/../../escaped", body: Buffer.from("bad"), mode: 0o755 },
    ]),
    tarGz([
      { name: "tool/", type: "5", mode: 0o755 },
      { name: "tool/bin/", type: "5", mode: 0o755 },
      { name: "tool/bin/go", type: "2", link: "../../../escaped", mode: 0o755 },
    ]),
    tarGz([
      { name: "tool/", type: "5", mode: 0o755 },
      { name: "tool/link", type: "2", link: "bin", mode: 0o755 },
      { name: "tool/link/go", body: Buffer.from("bad"), mode: 0o755 },
    ]),
  ];
  for (const [index, body] of fixtures.entries()) {
    const root = await mkdtemp(join(tmpdir(), `pi-archive-reject-${index}-`));
    const store = new EnvironmentStore(root);
    await withServer(body, async (url) => {
      await assert.rejects(installArchiveRuntime(store, {
        profile: "go",
        version: `1.24.${index}`,
        platform: "linux-arm64",
        url,
        sha256: createHash("sha256").update(body).digest("hex"),
        format: "tar.gz",
        stripComponents: 1,
        executable: "bin/go",
      }, { allowInsecureLocalhost: true }), /path|link|escape/i);
    });
  }
});

test("archive runtime installer enforces expanded-size and entry limits", async () => {
  const body = tarGz([
    { name: "tool/", type: "5", mode: 0o755 },
    { name: "tool/bin/", type: "5", mode: 0o755 },
    { name: "tool/bin/go", body: Buffer.alloc(64, 1), mode: 0o755 },
  ]);
  const root = await mkdtemp(join(tmpdir(), "pi-archive-limits-"));
  await withServer(body, async (url) => {
    const manifest = {
      profile: "go",
      version: "1.24.2",
      platform: "linux-arm64",
      url,
      sha256: createHash("sha256").update(body).digest("hex"),
      format: "tar.gz",
      stripComponents: 1,
      executable: "bin/go",
    };
    await assert.rejects(installArchiveRuntime(new EnvironmentStore(join(root, "bytes")), manifest, {
      allowInsecureLocalhost: true,
      maxExtractedBytes: 32,
    }), /expands beyond/);
    await assert.rejects(installArchiveRuntime(new EnvironmentStore(join(root, "entries")), manifest, {
      allowInsecureLocalhost: true,
      maxArchiveEntries: 1,
    }), /exceeds 1 entries/);
  });
});

test("raw runtime installer rejects digest mismatch and insecure remote URLs", async () => {
  const body = Buffer.from("not trusted");
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-installer-reject-"));
  const store = new EnvironmentStore(root);

  await withServer(body, async (url) => {
    await assert.rejects(installRawRuntime(store, {
      profile: "kubectl",
      version: "1.32.3",
      platform: "linux-arm64",
      url,
      sha256: "0".repeat(64),
      executable: "kubectl",
    }, { allowInsecureLocalhost: true }), /SHA-256 mismatch/);
  });

  await assert.rejects(installRawRuntime(store, {
    profile: "kubectl",
    version: "1.32.3",
    platform: "linux-arm64",
    url: "http://example.com/kubectl",
    sha256: "0".repeat(64),
    executable: "kubectl",
  }), /HTTPS/);

  await assert.rejects(installRawRuntime(store, {
    profile: "kubectl",
    version: "1.32.3",
    platform: "linux-arm64",
    url: "https://trusted.example/kubectl",
    sha256: "0".repeat(64),
    executable: "kubectl",
  }, {
    fetch: async () => {
      const redirected = new Response(body);
      Object.defineProperty(redirected, "url", { value: "https://attacker.example/kubectl" });
      return redirected;
    },
  }), /untrusted origin/);
});

function tarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    writeText(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, entry.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.link) writeText(header, 157, 100, entry.link);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const encodedChecksum = checksum.toString(8).padStart(6, "0");
    header.write(encodedChecksum, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, body);
    const remainder = body.length % 512;
    if (remainder) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeText(buffer, offset, length, value) {
  assert.ok(Buffer.byteLength(value) < length, `tar field too long: ${value}`);
  buffer.write(value, offset, length, "utf8");
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}
