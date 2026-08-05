import { randomUUID } from "node:crypto";
import { rename, stat, unlink } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isPlanModeActive } from "../work-status/plan-mode-state.ts";
import {
  DEFAULT_CONNECTION_POLICY,
  SshAuthorization,
  type ConnectionRetryPolicy,
} from "./authorization.ts";
import {
  runWithConnectionRetry,
  type ConnectionRetryMode,
  type RetriedProcessResult,
} from "./connection-retry.ts";
import {
  buildCancelJobScript,
  buildJobStatusScript,
  buildStartJobScript,
  parseJobStatus,
  parseStartedJob,
  type RemoteJobState,
} from "./job-protocol.ts";
import { MaskedPasswordInput } from "./password-input.ts";
import {
  askpassEnvironment,
  isAuthenticationFailure,
  runProcess,
  scpArguments,
  shellQuote,
  sshArguments,
  type ProcessOptions,
  type ProcessResult,
} from "./remote-process.ts";
import {
  SshToolActivation,
  type SshCapability,
} from "./tool-activation.ts";
import {
  validateHost,
  validateRemotePath,
  workspaceDownloadPath,
  workspaceUploadPath,
} from "./validation.ts";

const MAX_COMMAND_LENGTH = 32_768;
const DEFAULT_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

const CAPABILITIES = Type.Array(
  Type.Union([
    Type.Literal("exec"),
    Type.Literal("files"),
    Type.Literal("jobs"),
  ]),
  {
    description: "Only the capability groups needed for the current remote task",
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  },
);

const HOST = Type.String({
  description: "SSH config alias or destination such as user@example.com",
  minLength: 1,
  maxLength: 255,
});

interface JobRecord {
  id: string;
  host: string;
  directory: string;
  pid: number;
  sudo: boolean;
  command: string;
  startedAt: string;
  state: RemoteJobState;
}

interface SshRunOptions extends ProcessOptions {
  retryMode?: ConnectionRetryMode;
  policy?: ConnectionRetryPolicy;
}

class SshSession {
  readonly authorization = new SshAuthorization();
  readonly jobs = new Map<string, JobRecord>();
  /** Hosts whose detached jobs may read the remote login profile in this session. */
  private readonly loginEnvironmentGranted = new Set<string>();
  private readonly sshPasswords = new Map<string, string>();
  private readonly sudoPasswords = new Map<string, string>();

  isLoginEnvironmentAuthorized(host: string): boolean {
    return this.loginEnvironmentGranted.has(host);
  }

  authorizeLoginEnvironment(host: string): void {
    this.loginEnvironmentGranted.add(host);
  }

  async authorize(
    host: string,
    capabilities: readonly SshCapability[],
    policy: ConnectionRetryPolicy,
    ctx: ExtensionContext,
  ): Promise<void> {
    validateHost(host);
    const missing = this.authorization.missingCapabilities(host, capabilities);
    if (missing.length === 0) {
      this.authorization.grant(host, [], policy);
      return;
    }
    await requireApproval(ctx, "Authorize SSH capabilities", authorizationMessage(host, missing, policy));
    if (!this.authorization.isConnected(host)) {
      const result = await this.runSsh(
        host,
        "true",
        { policy, retryMode: "transport", signal: ctx.signal },
        ctx,
      );
      requireSuccess(result, `Unable to connect to ${host}`);
    }
    this.authorization.grant(host, missing, policy);
  }

  assertCapability(host: string, capability: SshCapability): void {
    validateHost(host);
    this.authorization.assertCapability(host, capability);
  }

  async runSsh(
    host: string,
    remoteCommand: string,
    options: SshRunOptions,
    ctx: ExtensionContext,
  ): Promise<RetriedProcessResult> {
    const policy = options.policy ?? this.authorization.policyFor(host);
    const retryMode = options.retryMode ?? "connect";
    const { retryMode: _retryMode, policy: _policy, ...processOptions } = options;
    const run = (password?: string) => runWithConnectionRetry(
      () => runProcess(
        "ssh",
        [...sshArguments(host, password, policy.connectTimeoutSeconds), remoteCommand],
        { ...processOptions, env: askpassEnvironment(password) },
      ),
      policy,
      retryMode,
      processOptions.signal,
    );
    const cached = this.sshPasswords.get(host);
    let result = await run(cached);
    if (!isAuthenticationFailure(result)) return result;

    if (cached) this.sshPasswords.delete(host);
    const password = await requestPassword(ctx, `SSH password for ${host}`);
    const authenticationAttempts = result.attempts;
    result = await run(password);
    if (isAuthenticationFailure(result)) throw new Error(`SSH authentication failed for ${host}.`);
    this.sshPasswords.set(host, password);
    return { ...result, attempts: authenticationAttempts + result.attempts };
  }

  async runScp(
    host: string,
    operands: readonly string[],
    options: SshRunOptions,
    ctx: ExtensionContext,
  ): Promise<RetriedProcessResult> {
    const policy = options.policy ?? this.authorization.policyFor(host);
    const { retryMode: _retryMode, policy: _policy, ...processOptions } = options;
    const run = (password?: string) => runWithConnectionRetry(
      () => runProcess(
        "scp",
        [...scpArguments(password, policy.connectTimeoutSeconds), ...operands],
        { ...processOptions, env: askpassEnvironment(password) },
      ),
      policy,
      "transport",
      processOptions.signal,
    );
    const cached = this.sshPasswords.get(host);
    let result = await run(cached);
    if (!isAuthenticationFailure(result)) return result;

    if (cached) this.sshPasswords.delete(host);
    const password = await requestPassword(ctx, `SSH password for ${host}`);
    const authenticationAttempts = result.attempts;
    result = await run(password);
    if (isAuthenticationFailure(result)) throw new Error(`SSH authentication failed for ${host}.`);
    this.sshPasswords.set(host, password);
    return { ...result, attempts: authenticationAttempts + result.attempts };
  }

  async runRemote(
    host: string,
    command: string,
    stdin: string | Buffer | undefined,
    sudo: boolean,
    options: SshRunOptions,
    ctx: ExtensionContext,
  ): Promise<RetriedProcessResult> {
    if (!sudo) return this.runSsh(host, command, { ...options, stdin }, ctx);

    const privileged = preparePrivilegedInput(command, stdin);

    const cached = this.sudoPasswords.get(host);
    if (cached) {
      const result = await this.runSsh(
        host,
        sudoPasswordCommand(privileged.command),
        { ...options, stdin: prependPassword(cached, privileged.stdin) },
        ctx,
      );
      if (!isBadSudoPassword(result)) return result;
      this.sudoPasswords.delete(host);
    } else {
      const result = await this.runSsh(
        host,
        sudoNonInteractiveCommand(privileged.command),
        { ...options, stdin: privileged.stdin },
        ctx,
      );
      if (!isSudoPasswordRequired(result)) return result;
    }

    const password = await requestPassword(ctx, `sudo password on ${host}`);
    const result = await this.runSsh(
      host,
      sudoPasswordCommand(privileged.command),
      { ...options, stdin: prependPassword(password, privileged.stdin) },
      ctx,
    );
    if (isBadSudoPassword(result)) throw new Error(`sudo authentication failed on ${host}.`);
    this.sudoPasswords.set(host, password);
    return result;
  }

  clearSecrets(): void {
    this.sshPasswords.clear();
    this.sudoPasswords.clear();
  }

  clearTurnAuthorization(): void {
    this.authorization.clearTurnGrants();
  }

  resetAuthorization(): void {
    this.authorization.reset();
    this.loginEnvironmentGranted.clear();
  }
}

export default function sshToolsExtension(pi: ExtensionAPI): void {
  const activation = new SshToolActivation(pi);
  const session = new SshSession();

  const syncJobs = () => {
    const running = [...session.jobs.values()].filter((job) => job.state === "running").length;
    activation.setJobCounts(session.jobs.size, running);
  };

  pi.registerTool({
    name: "ssh_enable",
    label: "Enable SSH tools",
    description: "Authorize one SSH host and selected capabilities for this agent run, with bounded connection retry settings.",
    promptSnippet: "Use ssh_enable before remote SSH work to activate the required capability groups",
    parameters: Type.Object({
      host: HOST,
      capabilities: CAPABILITIES,
      connect_timeout_seconds: Type.Optional(Type.Integer({
        description: "Timeout for establishing each SSH connection",
        minimum: 1,
        maximum: 60,
      })),
      connection_retries: Type.Optional(Type.Integer({
        description: "Retries after retryable SSH connection failures",
        minimum: 0,
        maximum: 3,
      })),
      retry_delay_ms: Type.Optional(Type.Integer({
        description: "Initial retry delay; later retries use exponential backoff",
        minimum: 100,
        maximum: 5000,
      })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("SSH authorization cancelled.");
      const capabilities = params.capabilities as SshCapability[];
      const policy = {
        connectTimeoutSeconds:
          params.connect_timeout_seconds ?? DEFAULT_CONNECTION_POLICY.connectTimeoutSeconds,
        retries: params.connection_retries ?? DEFAULT_CONNECTION_POLICY.retries,
        retryDelayMs: params.retry_delay_ms ?? DEFAULT_CONNECTION_POLICY.retryDelayMs,
      };
      await session.authorize(params.host, capabilities, policy, ctx);
      const active = activation.activate(capabilities);
      return {
        content: [{
          type: "text",
          text: `Authorized ${params.host}. Activated: ${active.filter((name) => name !== "ssh_enable").join(", ") || "none"}.`,
        }],
        details: { host: params.host, capabilities, connectionPolicy: policy },
        addedToolNames: active.filter((name) => name !== "ssh_enable"),
      };
    },
  });

  pi.registerTool({
    name: "ssh_exec",
    label: "SSH execute",
    description: "Run one bounded foreground shell command on an authorized SSH host. Use ssh_job_start for long work.",
    parameters: Type.Object({
      host: HOST,
      command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_LENGTH }),
      cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      sudo: Type.Optional(Type.Boolean({ description: "Run through sudo after interactive approval" })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
      max_output_bytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: MAX_OUTPUT_BYTES })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      session.assertCapability(params.host, "exec");
      if (params.sudo) {
        await requireApproval(
          ctx,
          "Run remote command with sudo",
          `${params.host}${params.cwd ? ` · ${params.cwd}` : ""}\n\n${preview(params.command)}`,
        );
      }
      const inner = params.cwd
        ? `cd -- ${shellQuote(params.cwd)} && exec sh -lc ${shellQuote(params.command)}`
        : `exec sh -lc ${shellQuote(params.command)}`;
      const result = await session.runRemote(
        params.host,
        `sh -lc ${shellQuote(inner)}`,
        undefined,
        params.sudo ?? false,
        {
          signal,
          timeoutMs: (params.timeout_seconds ?? 60) * 1000,
          maxOutputBytes: params.max_output_bytes ?? DEFAULT_OUTPUT_BYTES,
          retryMode: "connect",
        },
        ctx,
      );
      const text = formatProcessResult(result);
      return {
        content: [{ type: "text", text }],
        details: processDetails(params.host, result),
      };
    },
  });

  pi.registerTool({
    name: "ssh_upload",
    label: "SSH upload",
    description: "Upload one binary-safe file from the current workspace to an authorized SSH host using scp.",
    parameters: Type.Object({
      host: HOST,
      local_path: Type.String({ minLength: 1, maxLength: 4096 }),
      remote_path: Type.String({ minLength: 1, maxLength: 4096 }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      session.assertCapability(params.host, "files");
      validateRemotePath(params.remote_path);
      const localPath = await workspaceUploadPath(ctx.cwd, params.local_path);
      const file = await stat(localPath);
      if (!file.isFile()) throw new Error("ssh_upload supports regular files only.");
      const result = await session.runScp(
        params.host,
        [localPath, `${params.host}:${params.remote_path}`],
        { signal, timeoutMs: 30 * 60 * 1000, maxOutputBytes: DEFAULT_OUTPUT_BYTES },
        ctx,
      );
      requireSuccess(result, "SSH upload failed");
      return {
        content: [{ type: "text", text: `Uploaded ${file.size} bytes to ${params.host}:${params.remote_path}.` }],
        details: { host: params.host, localPath, remotePath: params.remote_path, bytes: file.size },
      };
    },
  });

  pi.registerTool({
    name: "ssh_download",
    label: "SSH download",
    description: "Download one binary-safe file from an authorized SSH host into the current workspace using scp.",
    parameters: Type.Object({
      host: HOST,
      remote_path: Type.String({ minLength: 1, maxLength: 4096 }),
      local_path: Type.String({ minLength: 1, maxLength: 4096 }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      session.assertCapability(params.host, "files");
      validateRemotePath(params.remote_path);
      const localPath = await workspaceDownloadPath(ctx.cwd, params.local_path);
      const temporary = `${localPath}.pi-ssh-${randomUUID()}.part`;
      try {
        const result = await session.runScp(
          params.host,
          [`${params.host}:${params.remote_path}`, temporary],
          { signal, timeoutMs: 30 * 60 * 1000, maxOutputBytes: DEFAULT_OUTPUT_BYTES },
          ctx,
        );
        requireSuccess(result, "SSH download failed");
        await rename(temporary, localPath);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      const file = await stat(localPath);
      return {
        content: [{ type: "text", text: `Downloaded ${file.size} bytes to ${localPath}.` }],
        details: { host: params.host, remotePath: params.remote_path, localPath, bytes: file.size },
      };
    },
  });

  pi.registerTool({
    name: "ssh_job_start",
    label: "Start SSH job",
    description: "Start a detached remote command and return a stable job ID for later status or cancellation.",
    parameters: Type.Object({
      host: HOST,
      command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_LENGTH }),
      cwd: Type.String({ minLength: 1, maxLength: 4096 }),
      sudo: Type.Optional(Type.Boolean({ description: "Run the detached job through sudo" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      session.assertCapability(params.host, "jobs");
      if (params.sudo) {
        await requireApproval(
          ctx,
          "Start remote sudo job",
          `${params.host} · ${params.cwd}\n\n${preview(params.command)}`,
        );
      }
      // A login shell reads the remote user's home profile (~/.profile and
      // friends), which may produce side effects or warnings in job output.
      // Ask once per host per session (cleared by /ssh-tools reset); declining
      // runs the job in a plain shell without the login environment.
      let login = true;
      if (!session.isLoginEnvironmentAuthorized(params.host)) {
        const approved = await getApproval(
          ctx,
          "Read remote login environment for job",
          `The detached job will start a login shell that reads the profile files of the target user on ${params.host} (~/.profile, ~/.bash_profile, ~/.zprofile, ...) so it inherits the login environment.\n\nDeclining starts the job in a plain shell without reading the profile.\n\n${params.host} · ${params.cwd}\n\n${preview(params.command)}`,
        );
        if (approved) session.authorizeLoginEnvironment(params.host);
        else login = false;
      }
      const id = randomUUID();
      const script = buildStartJobScript(id, params.cwd, params.command, { login });
      const result = await session.runRemote(
        params.host,
        "sh -s",
        script,
        params.sudo ?? false,
        {
          signal,
          timeoutMs: 20_000,
          maxOutputBytes: DEFAULT_OUTPUT_BYTES,
          retryMode: "transport",
        },
        ctx,
      );
      requireSuccess(result, "Unable to start remote job");
      const started = parseStartedJob(result.stdout.toString("utf8"));
      session.jobs.set(id, {
        id,
        host: params.host,
        directory: started.directory,
        pid: started.pid,
        sudo: params.sudo ?? false,
        command: params.command,
        startedAt: new Date().toISOString(),
        state: "running",
      });
      syncJobs();
      return {
        content: [{ type: "text", text: `Started SSH job ${id} on ${params.host} (PID ${started.pid}).` }],
        details: { jobId: id, host: params.host, pid: started.pid, startedAt: new Date().toISOString() },
        addedToolNames: ["ssh_job_status", "ssh_job_cancel"],
      };
    },
  });

  pi.registerTool({
    name: "ssh_job_status",
    label: "SSH job status",
    description: "Read state and bounded incremental stdout/stderr for a job started by this Pi session.",
    parameters: Type.Object({
      job_id: Type.String({ minLength: 1 }),
      stdout_offset: Type.Optional(Type.Integer({ minimum: 0 })),
      stderr_offset: Type.Optional(Type.Integer({ minimum: 0 })),
      max_bytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 65_536 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const job = requireJob(session.jobs, params.job_id);
      const stdoutOffset = params.stdout_offset ?? 0;
      const stderrOffset = params.stderr_offset ?? 0;
      const script = buildJobStatusScript(
        job.directory,
        stdoutOffset,
        stderrOffset,
        params.max_bytes ?? 8192,
      );
      const result = await session.runRemote(
        job.host,
        "sh -s",
        script,
        job.sudo,
        {
          signal,
          timeoutMs: 20_000,
          maxOutputBytes: 192 * 1024,
          retryMode: "transport",
        },
        ctx,
      );
      requireSuccess(result, "Unable to read remote job status");
      const status = parseJobStatus(result.stdout.toString("utf8"));
      job.state = status.state;
      syncJobs();
      const nextStdoutOffset = Math.min(status.stdoutSize, stdoutOffset + status.stdoutBytes);
      const nextStderrOffset = Math.min(status.stderrSize, stderrOffset + status.stderrBytes);
      return {
        content: [{
          type: "text",
          text: formatJobStatus(job, status, nextStdoutOffset, nextStderrOffset),
        }],
        details: {
          jobId: job.id,
          host: job.host,
          ...status,
          nextStdoutOffset,
          nextStderrOffset,
        },
      };
    },
  });

  pi.registerTool({
    name: "ssh_job_cancel",
    label: "Cancel SSH job",
    description: "Terminate a running job started by this Pi session, escalating from TERM to KILL after a grace period.",
    parameters: Type.Object({
      job_id: Type.String({ minLength: 1 }),
      grace_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 30 })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const job = requireJob(session.jobs, params.job_id);
      await requireApproval(
        ctx,
        "Cancel remote job",
        `${job.id} on ${job.host}\n\n${preview(job.command)}`,
      );
      const script = buildCancelJobScript(job.directory, params.grace_seconds ?? 5);
      const result = await session.runRemote(
        job.host,
        "sh -s",
        script,
        job.sudo,
        {
          signal,
          timeoutMs: 45_000,
          maxOutputBytes: DEFAULT_OUTPUT_BYTES,
          retryMode: "transport",
        },
        ctx,
      );
      requireSuccess(result, "Unable to cancel remote job");
      const cancellation = result.stdout.toString("utf8");
      if (cancellation.includes("PI_JOB_CANCEL\tcancelled")) {
        job.state = "cancelled";
      } else {
        const checked = await session.runRemote(
          job.host,
          "sh -s",
          buildJobStatusScript(job.directory, 0, 0, 256),
          job.sudo,
          {
            signal,
            timeoutMs: 20_000,
            maxOutputBytes: DEFAULT_OUTPUT_BYTES,
            retryMode: "transport",
          },
          ctx,
        );
        requireSuccess(checked, "Unable to confirm remote job state");
        job.state = parseJobStatus(checked.stdout.toString("utf8")).state;
      }
      syncJobs();
      return {
        content: [{
          type: "text",
          text: job.state === "cancelled"
            ? `Cancellation requested for SSH job ${job.id}.`
            : `SSH job ${job.id} was already stopped (${job.state}).`,
        }],
        details: { jobId: job.id, host: job.host, state: job.state },
      };
    },
  });

  pi.registerCommand("ssh-tools", {
    description: "Show SSH tool state or use /ssh-tools off|on|reset",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "off") {
        activation.setEnabled(false);
        session.clearTurnAuthorization();
        session.clearSecrets();
        ctx.ui.notify("SSH tools disabled; remote jobs continue running.", "info");
        return;
      }
      if (action === "on") {
        activation.setEnabled(true);
        ctx.ui.notify("SSH tool discovery enabled.", "info");
        return;
      }
      if (action === "reset") {
        session.resetAuthorization();
        session.clearSecrets();
        activation.settle();
        ctx.ui.notify("SSH host authorizations and cached passwords cleared; remote jobs continue running.", "info");
        return;
      }
      const hosts = session.authorization.getHosts().join(", ") || "none";
      const running = [...session.jobs.values()].filter((job) => job.state === "running").length;
      ctx.ui.notify(`Authorized hosts: ${hosts}\nTracked jobs: ${session.jobs.size} (${running} running)`, "info");
    },
  });

  pi.on("session_start", () => activation.sync(isPlanModeActive()));
  pi.on("before_agent_start", () => activation.sync(isPlanModeActive()));
  pi.on("agent_settled", () => {
    session.clearTurnAuthorization();
    activation.settle();
    activation.sync(isPlanModeActive());
  });
  pi.on("session_shutdown", () => session.clearSecrets());
}

function authorizationMessage(
  host: string,
  capabilities: readonly SshCapability[],
  policy: ConnectionRetryPolicy,
): string {
  const labels: Record<SshCapability, string> = {
    exec: "execute foreground commands",
    files: "upload and download workspace files",
    jobs: "start detached remote jobs",
  };
  const grants = capabilities.map((capability) => `• ${labels[capability]}`).join("\n");
  return `Allow ${host} for this agent run?\n\n${grants}\n\nConnection timeout: ${policy.connectTimeoutSeconds}s\nConnection retries: ${policy.retries}`;
}

async function requestPassword(ctx: ExtensionContext, title: string): Promise<string> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    throw new Error(`${title} requires interactive TUI mode.`);
  }
  const password = await ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => new MaskedPasswordInput(tui, theme, title, done),
  );
  if (password === undefined) throw new Error("Password entry cancelled.");
  if (!password || /[\r\n\0]/.test(password)) throw new Error("Password must be non-empty and single-line.");
  return password;
}

async function requireApproval(
  ctx: ExtensionContext,
  title: string,
  message: string,
): Promise<void> {
  if (!(await getApproval(ctx, title, message))) {
    throw new Error("Remote SSH action was not approved.");
  }
}

/**
 * Ask for approval and return whether it was granted, without throwing on a
 * decline. Callers that have a safe fallback (for example running a job in a
 * plain shell instead of a login shell) can use this instead of
 * `requireApproval`.
 */
async function getApproval(
  ctx: ExtensionContext,
  title: string,
  message: string,
): Promise<boolean> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    throw new Error("Remote SSH actions require interactive approval in TUI mode.");
  }
  return ctx.ui.confirm(title, message);
}

function sudoNonInteractiveCommand(command: string): string {
  return `sudo -n -H sh -lc ${shellQuote(command)}`;
}

function sudoPasswordCommand(command: string): string {
  return `sudo -S -H -p '' sh -lc ${shellQuote(command)}`;
}

function preparePrivilegedInput(
  command: string,
  stdin: string | Buffer | undefined,
): { command: string; stdin: string | Buffer | undefined } {
  if (command !== "sh -s" || stdin === undefined) return { command, stdin };
  const encoded = Buffer.from(stdin).toString("base64");
  const decoder = "if printf '' | base64 -d >/dev/null 2>&1; then base64 -d; else base64 -D; fi";
  return {
    command: `printf %s ${shellQuote(encoded)} | (${decoder}) | sh`,
    stdin: undefined,
  };
}

function prependPassword(password: string, input: string | Buffer | undefined): Buffer {
  const suffix = input === undefined ? Buffer.alloc(0) : Buffer.from(input);
  return Buffer.concat([Buffer.from(`${password}\n`), suffix]);
}

function isSudoPasswordRequired(result: ProcessResult): boolean {
  return result.exitCode !== 0 && /password is required|a password is required|no tty present/i.test(
    result.stderr.toString("utf8"),
  );
}

function isBadSudoPassword(result: ProcessResult): boolean {
  return result.exitCode !== 0 && /sorry, try again|incorrect password|authentication failure/i.test(
    result.stderr.toString("utf8"),
  );
}

function requireSuccess(result: ProcessResult, prefix: string): void {
  if (result.aborted) throw new Error(`${prefix}: cancelled.`);
  if (result.timedOut) throw new Error(`${prefix}: timed out.`);
  if (result.exitCode === 0) return;
  const stderr = result.stderr.toString("utf8").trim();
  const attempts = processAttempts(result);
  const attemptText = attempts > 1 ? ` after ${attempts} attempts` : "";
  throw new Error(`${prefix}${attemptText} (exit ${result.exitCode ?? result.signal ?? "unknown"})${stderr ? `: ${stderr}` : "."}`);
}

function formatProcessResult(result: ProcessResult): string {
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr.toString("utf8");
  const sections = [
    `Exit code: ${result.exitCode ?? result.signal ?? "unknown"}`,
    stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
    stderr ? `stderr:\n${stderr}` : "stderr: (empty)",
  ];
  if (result.timedOut) sections.push("The local SSH process timed out; a detached remote child may still be running.");
  if (result.aborted) sections.push("The local SSH process was cancelled.");
  if (result.truncated) sections.push("Output was truncated at the configured byte limit.");
  if (processAttempts(result) > 1) sections.push(`SSH process attempts: ${processAttempts(result)}.`);
  return sections.join("\n\n");
}

function processDetails(host: string, result: ProcessResult): Record<string, unknown> {
  return {
    host,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    truncated: result.truncated,
    attempts: processAttempts(result),
  };
}

function processAttempts(result: ProcessResult): number {
  const attempts = (result as ProcessResult & { attempts?: number }).attempts;
  return Number.isSafeInteger(attempts) && attempts! > 0 ? attempts! : 1;
}

function requireJob(jobs: ReadonlyMap<string, JobRecord>, id: string): JobRecord {
  const job = jobs.get(id);
  if (!job) throw new Error(`Unknown SSH job ID: ${id}`);
  return job;
}

function formatJobStatus(
  job: JobRecord,
  status: ReturnType<typeof parseJobStatus>,
  nextStdoutOffset: number,
  nextStderrOffset: number,
): string {
  const lines = [
    `Job: ${job.id}`,
    `Host: ${job.host}`,
    `State: ${status.state}`,
    `PID: ${status.pid}`,
    `Exit code: ${status.exitCode ?? "pending"}`,
    `Next offsets: stdout=${nextStdoutOffset}, stderr=${nextStderrOffset}`,
  ];
  if (status.stdout) lines.push(`stdout:\n${status.stdout}`);
  if (status.stderr) lines.push(`stderr:\n${status.stderr}`);
  if (nextStdoutOffset < status.stdoutSize || nextStderrOffset < status.stderrSize) {
    lines.push("More output is available; call ssh_job_status again with the returned offsets.");
  }
  return lines.join("\n\n");
}

function preview(value: string): string {
  return value.length <= 1000 ? value : `${value.slice(0, 1000)}\n… (${value.length - 1000} more characters)`;
}
