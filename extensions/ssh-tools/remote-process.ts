import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ASKPASS_PATH = fileURLToPath(new URL("./ssh-askpass.cjs", import.meta.url));

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

export interface ProcessOptions {
  stdin?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  const child = spawn(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env,
  });
  const stdout = new BoundedBuffer(maxOutputBytes);
  const stderr = new BoundedBuffer(maxOutputBytes);
  let timedOut = false;
  let aborted = false;

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();

  const stop = (reason: "timeout" | "abort") => {
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    child.kill("SIGTERM");
  };
  const timer = options.timeoutMs
    ? setTimeout(() => stop("timeout"), options.timeoutMs)
    : undefined;
  const onAbort = () => stop("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
      },
    );
    return {
      stdout: stdout.value(),
      stderr: stderr.value(),
      exitCode: result.code,
      signal: result.signal,
      timedOut,
      aborted,
      truncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function sshArguments(host: string, password?: string): string[] {
  return [
    "-o", "ConnectTimeout=10",
    "-o", `BatchMode=${password ? "no" : "yes"}`,
    "-o", "NumberOfPasswordPrompts=1",
    host,
  ];
}

export function scpArguments(password?: string): string[] {
  return [
    "-o", "ConnectTimeout=10",
    "-o", `BatchMode=${password ? "no" : "yes"}`,
    "-o", "NumberOfPasswordPrompts=1",
  ];
}

export function askpassEnvironment(password?: string): NodeJS.ProcessEnv | undefined {
  if (!password) return undefined;
  return {
    ...process.env,
    DISPLAY: process.env.DISPLAY || "pi-ssh-askpass",
    SSH_ASKPASS: ASKPASS_PATH,
    SSH_ASKPASS_REQUIRE: "force",
    PI_SSH_ASKPASS_SECRET: password,
  };
}

export function isAuthenticationFailure(result: ProcessResult): boolean {
  if (result.exitCode !== 255) return false;
  return /permission denied|authentication failed|password:|keyboard-interactive/i.test(
    result.stderr.toString("utf8"),
  );
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

class BoundedBuffer {
  private readonly limit: number;
  private chunks: Buffer[] = [];
  private length = 0;
  truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.length >= this.limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.limit - this.length;
    const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.chunks.push(kept);
    this.length += kept.length;
    if (kept.length < chunk.length) this.truncated = true;
  }

  value(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}
