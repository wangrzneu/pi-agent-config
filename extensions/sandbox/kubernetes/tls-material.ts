import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { isIP } from "node:net";

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

function createSelfSignedCertificate(key: Buffer, ipAddresses: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENSSL, [
      "req", "-x509", "-new",
      "-key", "/dev/stdin",
      "-out", "/dev/stdout",
      "-days", "1",
      "-subj", `/CN=${ipAddresses[0]}`,
      "-addext", `subjectAltName=${ipAddresses.map((address) => `IP:${address}`).join(",")}`,
    ], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OPENSSL_OUTPUT_BYTES) {
        fail(new Error("OpenSSL certificate output exceeded the safety limit"));
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
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
      resolve(Buffer.concat(stdout));
    });
    child.stdin.once("error", fail);
    child.stdin.end(key);
  });
}
