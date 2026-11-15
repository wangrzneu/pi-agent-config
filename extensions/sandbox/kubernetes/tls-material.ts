import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPENSSL = "/usr/bin/openssl";
const MAX_OPENSSL_OUTPUT_BYTES = 1024 * 1024;

export interface KubernetesGatewayTlsMaterial {
  key: Buffer;
  cert: Buffer;
  caData: string;
}

export async function createKubernetesGatewayTlsMaterial(
  _directory: string,
  ipAddresses: string[] = ["127.0.0.1"],
): Promise<KubernetesGatewayTlsMaterial> {
  if (ipAddresses.length === 0 || ipAddresses.some((address) => isIP(address) === 0)) {
    throw new Error("Kubernetes gateway TLS SANs must be IP addresses");
  }
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = Buffer.from(privateKey);
  const cert = await createSelfSignedCertificate(key, [...new Set(ipAddresses)]);
  return { key, cert, caData: cert.toString("base64") };
}

async function createSelfSignedCertificate(
  key: Buffer,
  ipAddresses: string[],
): Promise<Buffer> {
  // Use a private temporary directory instead of /dev/stdin and /dev/stdout.
  // Some Linux CI/container OpenSSL builds cannot open /dev/stdin for a child
  // process, and writing through the caller's directory would follow
  // sandbox-controlled symlinks.
  const directory = await mkdtemp(join(tmpdir(), "pi-kube-tls-"));
  const keyPath = join(directory, "gateway.key");
  const certPath = join(directory, "gateway.crt");
  try {
    await writeFile(keyPath, key, { mode: 0o600 });
    await runOpenSsl(keyPath, certPath, ipAddresses);
    return await readFile(certPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runOpenSsl(
  keyPath: string,
  certPath: string,
  ipAddresses: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENSSL, [
      "req", "-x509", "-new",
      "-key", keyPath,
      "-out", certPath,
      "-days", "1",
      "-subj", `/CN=${ipAddresses[0]}`,
      "-addext", `subjectAltName=${ipAddresses.map((address) => `IP:${address}`).join(",")}`,
    ], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OPENSSL_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(
          `OpenSSL certificate generation failed (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`,
        ));
        return;
      }
      resolve();
    });
  });
}
