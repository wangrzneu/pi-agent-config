export const SSH_TOOL_NAMES = [
  "ssh_enable",
  "ssh_exec",
  "ssh_upload",
  "ssh_download",
  "ssh_job_start",
  "ssh_job_status",
  "ssh_job_cancel",
] as const;

export type SshToolName = (typeof SSH_TOOL_NAMES)[number];
export type SshCapability = "exec" | "files" | "jobs";

const TOOL_SET = new Set<string>(SSH_TOOL_NAMES);
const CAPABILITY_TOOLS: Record<SshCapability, SshToolName[]> = {
  exec: ["ssh_exec"],
  files: ["ssh_upload", "ssh_download"],
  jobs: ["ssh_job_start"],
};

export interface ActiveToolAPI {
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}

export class SshToolActivation {
  private readonly pi: ActiveToolAPI;
  private turnCapabilities = new Set<SshCapability>();
  private knownJobs = 0;
  private runningJobs = 0;
  private enabled = true;

  constructor(pi: ActiveToolAPI) {
    this.pi = pi;
  }

  activate(capabilities: readonly SshCapability[]): string[] {
    for (const capability of capabilities) {
      this.turnCapabilities.add(capability);
    }
    this.sync();
    return this.desiredTools();
  }

  settle(): void {
    this.turnCapabilities.clear();
    this.sync();
  }

  setJobCounts(known: number, running: number): void {
    this.knownJobs = Math.max(0, known);
    this.runningJobs = Math.max(0, Math.min(running, this.knownJobs));
    this.sync();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.turnCapabilities.clear();
    this.sync();
  }

  sync(suspended = false): void {
    const current = this.pi.getActiveTools();
    const external = current.filter((name) => !TOOL_SET.has(name));
    const desired = suspended ? [] : this.desiredTools();
    const next = [...external, ...desired];
    if (!sameTools(current, next)) this.pi.setActiveTools(next);
  }

  getCapabilities(): SshCapability[] {
    return [...this.turnCapabilities];
  }

  private desiredTools(): SshToolName[] {
    if (!this.enabled) return [];

    const tools: SshToolName[] = ["ssh_enable"];
    for (const capability of this.turnCapabilities) {
      tools.push(...CAPABILITY_TOOLS[capability]);
    }
    if (this.knownJobs > 0) tools.push("ssh_job_status");
    if (this.runningJobs > 0) tools.push("ssh_job_cancel");
    return [...new Set(tools)];
  }
}

function sameTools(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}
