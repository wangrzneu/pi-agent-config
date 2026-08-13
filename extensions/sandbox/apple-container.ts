import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { AppleContainerConfig, SandboxConfig } from "./config.ts";
import { codingCacheEnvironment, SandboxProcessTracker } from "./process.ts";
import { SANDBOX_TEMP_ROOT } from "./sandbox-paths.ts";
import {
  assertApfsPath,
  createTransactionalWorkspace,
  discardTransactionalWorkspace,
  reconcileTransactionalWorkspace,
} from "./transactional-workspace.ts";
import type { GitIdentity } from "./git-identity.ts";

const GUEST_CACHE_ROOT = "/var/pi-cache";
const TRANSACTION_ROOT = join(SANDBOX_TEMP_ROOT, "transactions");
const TERMINATION_GRACE_MS = 1_500;
const PREFLIGHT_COMMAND_TIMEOUT_MS = 12_000;

export interface AppleContainerPolicySource {
  config: SandboxConfig;
  readGrants: string[];
  writeGrants: string[];
}

export interface AppleContainerOperationsOptions {
  tracker: SandboxProcessTracker;
  container: AppleContainerConfig;
  policy: () => AppleContainerPolicySource;
  gitIdentity: () => GitIdentity | undefined;
  authorizeNetwork: (host: string, port?: number) => Promise<boolean>;
}

export interface AppleContainerLifecycle {
  preflight(config: AppleContainerConfig, workspace?: string): Promise<void>;
  track(name: string): void;
  release(name: string): void;
  forceDelete(binary: string, name: string): Promise<void>;
  stopAll(binary: string): Promise<void>;
}

export class AppleContainerController implements AppleContainerLifecycle {
  private readonly activeNames = new Set<string>();

  async preflight(config: AppleContainerConfig, workspace?: string): Promise<void> {
    validateAppleContainerConfig(config);
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new Error("Apple Container isolation requires macOS on Apple silicon");
    }
    if (!existsSync(config.binary)) throw new Error(`Apple container CLI not found: ${config.binary}`);
    const version = await captureCommand(config.binary, ["--version"]);
    if (!/\b0\.10\./.test(version)) {
      throw new Error(`Apple container CLI 0.10.x is required; found: ${version.trim()}`);
    }
    await captureCommand(config.binary, ["system", "status", "--format", "json"]);
    await captureCommand(config.binary, ["image", "inspect", config.image]);
    await mkdir(join(SANDBOX_TEMP_ROOT, "cache"), { recursive: true, mode: 0o700 });
    await mkdir(TRANSACTION_ROOT, { recursive: true, mode: 0o700 });
    if (workspace !== undefined) {
      await assertApfsPath(workspace);
      await assertApfsPath(TRANSACTION_ROOT);
    }
  }

  track(name: string): void {
    this.activeNames.add(name);
  }

  release(name: string): void {
    this.activeNames.delete(name);
  }

  async forceDelete(binary: string, name: string): Promise<void> {
    this.activeNames.delete(name);
    await captureCommand(binary, ["delete", "--force", name]).catch(() => undefined);
  }

  async stopAll(binary: string): Promise<void> {
    await Promise.all([...this.activeNames].map((name) => this.forceDelete(binary, name)));
  }
}

export function createAppleContainerBashOperations(
  controller: AppleContainerLifecycle,
  options: AppleContainerOperationsOptions,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");
      const source = options.policy();
      if (source.writeGrants.length > 0) {
        throw new Error(
          "Apple Container mode does not yet support transactional external write grants; revoke them or use the process-only sandbox.",
        );
      }
      const readMounts = await inspectReadGrantDirectories(source.readGrants, cwd);
      const transaction = await createTransactionalWorkspace(cwd, TRANSACTION_ROOT);
      const name = `pi-sbx-${process.pid}-${randomUUID().slice(0, 12)}`;
      controller.track(name);

      const guestPolicy = compileGuestPolicy(source.config, cwd, readMounts);
      const guestEnv = guestCodingEnvironment(env ?? process.env, options.gitIdentity());
      const request = {
        type: "execute",
        command,
        cwd,
        shell: options.container.shell,
        env: guestEnv,
        policy: guestPolicy,
      };
      const args = buildContainerRunArgs({
        config: options.container,
        name,
        workspaceSource: transaction.staged,
        workspaceTarget: cwd,
        readMounts,
      });
      let child: ChildProcess | undefined;
      let timedOut = false;
      let protocolError: Error | undefined;
      let guestExitCode: number | null | undefined;
      let stdoutBuffer = "";
      let launcherStderr = "";
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;
      const terminate = (reason: "abort" | "timeout") => {
        if (reason === "timeout") timedOut = true;
        writeProtocol(child, { type: "cancel" });
        void controller.forceDelete(options.container.binary, name);
        terminateProcessTree(child, "SIGTERM");
        killHandle ??= setTimeout(() => terminateProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
        killHandle.unref?.();
      };
      const onAbort = () => terminate("abort");

      try {
        // Apple container's XPC client intentionally does not work from inside
        // sandbox-exec (even `(allow default)` reports the apiserver as
        // unregistered). Keep this trusted launcher out of Seatbelt and make its
        // interface data-only: a fixed binary plus argv generated exclusively by
        // buildContainerRunArgs. User command text travels over stdin to guest
        // ASRT and can never become a host shell command or mount argument.
        child = spawn(options.container.binary, args, {
          cwd,
          detached: true,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        options.tracker.track(child);
        child.stderr?.on("data", (chunk: Buffer) => {
          onData(chunk);
          launcherStderr = `${launcherStderr}${chunk.toString("utf8")}`.slice(-8_192);
        });
        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuffer += chunk.toString("utf8");
          let newline: number;
          while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
            const line = stdoutBuffer.slice(0, newline);
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (!line) continue;
            try {
              const message = JSON.parse(line) as GuestMessage;
              if (message.type === "stdout" || message.type === "stderr") {
                onData(Buffer.from(message.data, "base64"));
              } else if (message.type === "networkRequest") {
                void options.authorizeNetwork(message.host, message.port).then((allowed) => {
                  writeProtocol(child, { type: "networkDecision", requestId: message.requestId, allowed });
                });
              } else if (message.type === "exit") {
                guestExitCode = message.exitCode;
              } else if (message.type === "error") {
                protocolError = new Error(`Apple Container guest sandbox failed: ${message.message}`);
              }
            } catch {
              protocolError = new Error(`Unexpected Apple Container output: ${line}`);
            }
          }
        });
        child.once("spawn", () => writeProtocol(child, request));

        if (timeout !== undefined) {
          timeoutHandle = setTimeout(() => terminate("timeout"), timeout * 1000);
          timeoutHandle.unref?.();
        }
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });

        const launcherExit = await childExitCode(child);
        if (stdoutBuffer.trim() && !protocolError) {
          protocolError = new Error(`Incomplete Apple Container protocol output: ${stdoutBuffer.trim()}`);
        }
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        if (protocolError) throw protocolError;
        if (launcherExit !== 0 && guestExitCode === undefined) {
          const detail = launcherStderr.trim();
          throw new Error(`Apple Container launcher exited with code ${launcherExit}${detail ? `: ${detail}` : ""}`);
        }
        if (guestExitCode === undefined) throw new Error("Apple Container guest exited without a result");

        await reconcileTransactionalWorkspace(transaction, {
          allowWrite: source.config.filesystem.allowWrite,
          denyWrite: source.config.filesystem.denyWrite,
        });
        return { exitCode: guestExitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);
        signal?.removeEventListener("abort", onAbort);
        controller.release(name);
        if (child?.exitCode === null && child.signalCode === null) await controller.forceDelete(options.container.binary, name);
        await discardTransactionalWorkspace(transaction);
      }
    },
  };
}

export function validateAppleContainerConfig(config: AppleContainerConfig): void {
  if (!isAbsolute(config.binary)) throw new Error("Apple container binary must be an absolute path");
  if (!config.image || /\s/.test(config.image)) throw new Error("Apple container image must be a non-empty OCI reference without whitespace");
  if (config.platform !== "linux/arm64") throw new Error("Apple Container sandbox images must use linux/arm64");
  if (!isAbsolute(config.shell)) throw new Error("Apple Container guest shell must be an absolute path");
  if (!Number.isInteger(config.cpus) || config.cpus < 1) throw new Error("Apple Container cpus must be a positive integer");
  if (!/^\d+(?:[kKmMgGtTpP])?$/.test(config.memory)) throw new Error("Apple Container memory must be an integer with an optional K/M/G/T/P suffix");
  if (config.pullPolicy !== "never") throw new Error("Apple Container pullPolicy must be 'never' to prevent implicit image downloads");
  if (config.workspaceMode !== "transactional-apfs") {
    throw new Error("Apple Container workspaceMode must be 'transactional-apfs' for strict policy parity");
  }
}

export function buildContainerRunArgs(input: {
  config: AppleContainerConfig;
  name: string;
  workspaceSource: string;
  workspaceTarget: string;
  readMounts: string[];
}): string[] {
  for (const path of [input.workspaceSource, input.workspaceTarget, ...input.readMounts]) {
    if (path.includes(",")) throw new Error(`Apple container mount paths containing commas are unsupported: ${path}`);
  }
  const args = [
    "run",
    "--rm",
    "--init",
    "--read-only",
    "--interactive",
    "--progress",
    "none",
    "--name",
    input.name,
    "--label",
    "com.pi.sandbox.managed=true",
    "--platform",
    input.config.platform,
    "--cpus",
    String(input.config.cpus),
    "--memory",
    input.config.memory,
    "--tmpfs",
    "/tmp",
    "--mount",
    mountDirective(input.workspaceSource, input.workspaceTarget, false),
    "--mount",
    mountDirective(join(SANDBOX_TEMP_ROOT, "cache"), GUEST_CACHE_ROOT, false),
  ];
  for (const path of input.readMounts) args.push("--mount", mountDirective(path, path, true));
  args.push(input.config.image);
  return args;
}

export function compileGuestPolicy(
  config: SandboxConfig,
  workspace: string,
  readMounts: string[],
): SandboxRuntimeConfig {
  const workspaceWritable = config.filesystem.allowWrite.some((entry) => {
    const allowed = entry === "." ? resolve(workspace) : resolve(workspace, entry);
    const target = resolve(workspace);
    return target === allowed || target.startsWith(`${allowed}${sep}`);
  });
  return {
    network: {
      ...structuredClone(config.network),
      allowMachLookup: undefined,
      // Apple Container's guest kernel rejects the nested user namespace used
      // by ASRT's apply-seccomp helper. The VM exposes no host Unix sockets, so
      // host IPC is already separated by the stronger VM boundary. Keep all
      // other guest Process restrictions (bwrap fs/PID/net namespaces and
      // proxy-only egress) without opting into weaker nested filesystem mode.
      allowAllUnixSockets: true,
    },
    filesystem: {
      denyRead: ["/"],
      allowRead: [
        workspace,
        ...readMounts,
        GUEST_CACHE_ROOT,
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/etc",
        "/dev",
        "/proc",
        "/sys",
        "/run",
        "/tmp",
        "/opt/pi-sandbox",
      ],
      allowWrite: ["/tmp", GUEST_CACHE_ROOT, ...(workspaceWritable ? [workspace] : [])],
      denyWrite: structuredClone(config.filesystem.denyWrite),
      allowGitConfig: config.filesystem.allowGitConfig,
    },
    credentials: structuredClone(config.credentials),
    ignoreViolations: structuredClone(config.ignoreViolations),
    enableWeakerNestedSandbox: false,
  };
}

function guestCodingEnvironment(env: NodeJS.ProcessEnv, identity?: GitIdentity): NodeJS.ProcessEnv {
  const host = codingCacheEnvironment(env, identity);
  const guest: NodeJS.ProcessEnv = {
    ...host,
    HOME: "/tmp/pi-home",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp",
  };
  for (const [name, value] of Object.entries(guest)) {
    if (typeof value === "string" && value.startsWith(join(SANDBOX_TEMP_ROOT, "cache"))) {
      guest[name] = value.replace(join(SANDBOX_TEMP_ROOT, "cache"), GUEST_CACHE_ROOT);
    }
  }
  return guest;
}

async function inspectReadGrantDirectories(paths: string[], cwd: string): Promise<string[]> {
  const directories: string[] = [];
  for (const rawPath of paths) {
    const path = resolve(cwd, rawPath);
    const stat = await lstat(path);
    if (!stat.isDirectory()) {
      throw new Error(
        `Apple Container shell access currently requires directory read grants; direct tools may still use this file grant: ${path}`,
      );
    }
    if (isInside(cwd, path)) continue;
    directories.push(path);
  }
  return [...new Set(directories)];
}

function isInside(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function mountDirective(source: string, target: string, readonly: boolean): string {
  return `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;
}

function writeProtocol(child: ChildProcess | undefined, message: unknown): void {
  if (!child?.stdin?.writable) return;
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

type GuestMessage =
  | { type: "ready" }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "networkRequest"; requestId: string; host: string; port?: number }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

function childExitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", resolvePromise);
  });
}

function terminateProcessTree(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function captureCommand(
  command: string,
  args: string[],
  timeoutMs: number = PREFLIGHT_COMMAND_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let killHandle: NodeJS.Timeout | undefined;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      killHandle = setTimeout(
        () => terminateProcessTree(child, "SIGKILL"),
        TERMINATION_GRACE_MS,
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      if (killHandle !== undefined) clearTimeout(killHandle);
    };

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      const invocation = `${command} ${args.join(" ")}`;
      if (timedOut) {
        reject(new Error(`${invocation} timed out after ${timeoutMs}ms`));
      } else if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new Error(`${invocation} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
      }
    });
  });
}
