import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SANDBOX_TEMP_ROOT } from "./sandbox-paths.ts";

const TERMINATION_GRACE_MS = 1_500;
const CACHE_ROOT = join(SANDBOX_TEMP_ROOT, "cache");

export interface SandboxCommandRuntime {
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  cleanupAfterCommand(): void;
}

export class SandboxProcessTracker {
  private readonly children = new Set<ChildProcess>();

  track(child: ChildProcess): void {
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
  }

  async stopAll(): Promise<void> {
    const children = [...this.children];
    for (const child of children) terminateProcessTree(child, "SIGTERM");
    await waitForChildren(children, TERMINATION_GRACE_MS);

    const survivors = children.filter((child) => child.exitCode === null && child.signalCode === null);
    for (const child of survivors) terminateProcessTree(child, "SIGKILL");
    await waitForChildren(survivors, TERMINATION_GRACE_MS);
  }
}

export function createSandboxedBashOperations(
  runtime: SandboxCommandRuntime,
  tracker: SandboxProcessTracker,
  commandConfig?: () => Partial<SandboxRuntimeConfig> | undefined,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute sandboxed bash commands.`);
      }
      if (signal?.aborted) throw new Error("aborted");

      let wrappedCommand: string;
      try {
        wrappedCommand = await runtime.wrapWithSandbox(command, undefined, commandConfig?.(), signal);
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        throw error;
      }
      if (signal?.aborted) throw new Error("aborted");

      const child = spawn("bash", ["-c", wrappedCommand], {
        cwd,
        detached: true,
        env: codingCacheEnvironment(env ?? process.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      tracker.track(child);
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;
      const terminate = (reason: "abort" | "timeout") => {
        if (reason === "timeout") timedOut = true;
        terminateProcessTree(child, "SIGTERM");
        killHandle ??= setTimeout(() => terminateProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
        killHandle.unref?.();
      };
      const onAbort = () => terminate("abort");

      if (timeout !== undefined) {
        timeoutHandle = setTimeout(() => terminate("timeout"), timeout * 1000);
        timeoutHandle.unref?.();
      }
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const exitCode = await childExitCode(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);
        signal?.removeEventListener("abort", onAbort);
        try {
          runtime.cleanupAfterCommand();
        } catch {
          // Cleanup is best-effort and must not replace the command result.
        }
      }
    },
  };
}

export function codingCacheEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    TMPDIR: join(SANDBOX_TEMP_ROOT, "tmp"),
    TMP: join(SANDBOX_TEMP_ROOT, "tmp"),
    TEMP: join(SANDBOX_TEMP_ROOT, "tmp"),
    XDG_CACHE_HOME: join(CACHE_ROOT, "xdg-cache"),
    XDG_DATA_HOME: join(CACHE_ROOT, "xdg-data"),
    XDG_CONFIG_HOME: join(CACHE_ROOT, "xdg-config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    npm_config_userconfig: "/dev/null",
    PIP_CONFIG_FILE: "/dev/null",
    npm_config_cache: join(CACHE_ROOT, "npm"),
    npm_config_store_dir: join(CACHE_ROOT, "pnpm-store"),
    pnpm_config_store_dir: join(CACHE_ROOT, "pnpm-store"),
    YARN_CACHE_FOLDER: join(CACHE_ROOT, "yarn"),
    PIP_CACHE_DIR: join(CACHE_ROOT, "pip"),
    UV_CACHE_DIR: join(CACHE_ROOT, "uv"),
    GOCACHE: join(CACHE_ROOT, "go-build"),
    GOMODCACHE: join(CACHE_ROOT, "go-mod"),
    GOPATH: join(CACHE_ROOT, "go-path"),
    CARGO_HOME: join(CACHE_ROOT, "cargo"),
    GRADLE_USER_HOME: join(CACHE_ROOT, "gradle"),
    NUGET_PACKAGES: join(CACHE_ROOT, "nuget"),
    DENO_DIR: join(CACHE_ROOT, "deno"),
  };
}

function childExitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve(code)));
  });
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

async function waitForChildren(children: ChildProcess[], timeoutMs: number): Promise<void> {
  if (children.length === 0) return;
  await Promise.race([
    Promise.all(children.map((child) => waitForChild(child))),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

function waitForChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}
