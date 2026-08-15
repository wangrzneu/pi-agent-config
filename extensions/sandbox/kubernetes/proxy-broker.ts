import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_STARTUP_TIMEOUT_MS = 12_000;
const STOP_GRACE_MS = 1_500;
const LOOPBACK_LINE = /Starting to serve on 127\.0\.0\.1:(\d+)/;

export interface KubectlProxyStartRequest {
  kubectl: string;
  context: string;
  env: NodeJS.ProcessEnv;
}

export interface KubectlProxyHandle {
  id: string;
  context: string;
  upstream: string;
}

export interface KubectlProxyBrokerOptions {
  spawn?: typeof spawn;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  startupTimeoutMs?: number;
}

interface ActiveProxy extends KubectlProxyHandle {
  child: ChildProcess;
}

export class KubectlProxyBroker {
  private readonly spawnProcess: typeof spawn;
  private readonly startupTimeoutMs: number;
  private readonly killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  private readonly active = new Map<string, ActiveProxy>();

  constructor(options: KubectlProxyBrokerOptions = {}) {
    this.spawnProcess = options.spawn ?? spawn;
    this.killProcessGroup = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  async start(request: KubectlProxyStartRequest): Promise<KubectlProxyHandle> {
    validateRequest(request);
    const args = [
      "proxy",
      "--context", request.context,
      "--address", "127.0.0.1",
      "--port", "0",
      "--accept-hosts", "^127\\.0\\.0\\.1$",
    ];
    const child = this.spawnProcess(request.kubectl, args, {
      env: { ...process.env, ...request.env },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const upstream = await waitForLoopbackEndpoint(child, this.startupTimeoutMs);
      const handle: ActiveProxy = {
        id: randomUUID(),
        context: request.context,
        upstream,
        child,
      };
      this.active.set(handle.id, handle);
      child.once("close", () => this.active.delete(handle.id));
      return publicHandle(handle);
    } catch (error) {
      terminate(child, "SIGTERM", this.killProcessGroup);
      throw error;
    }
  }

  async stop(id: string): Promise<void> {
    const proxy = this.active.get(id);
    if (!proxy) return;
    this.active.delete(id);
    terminate(proxy.child, "SIGTERM", this.killProcessGroup);
    if (await waitForClose(proxy.child, STOP_GRACE_MS)) return;
    terminate(proxy.child, "SIGKILL", this.killProcessGroup);
    await waitForClose(proxy.child, STOP_GRACE_MS);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)));
  }
}

function waitForLoopbackEndpoint(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("close", onClose);
      callback();
    };
    const inspect = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-8_192);
      const match = output.match(LOOPBACK_LINE);
      if (match) finish(() => resolve(`http://127.0.0.1:${match[1]}`));
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = output.trim();
      finish(() => reject(new Error(
        `kubectl proxy exited before startup (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      )));
    };
    const timer = setTimeout(() => finish(() => reject(new Error(
      `kubectl proxy did not report a loopback endpoint within ${timeoutMs}ms`,
    ))), timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function publicHandle(proxy: ActiveProxy): KubectlProxyHandle {
  return { id: proxy.id, context: proxy.context, upstream: proxy.upstream };
}

function validateRequest(request: KubectlProxyStartRequest): void {
  if (!request.kubectl || /[\0\r\n]/.test(request.kubectl)) {
    throw new Error("kubectl executable path is invalid");
  }
  if (!request.context || /[\0\r\n]/.test(request.context)) {
    throw new Error("Kubernetes context name is invalid");
  }
}

function terminate(
  child: ChildProcess,
  signal: NodeJS.Signals,
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid !== undefined) killProcessGroup(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process group may already have exited.
  }
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
  });
}
