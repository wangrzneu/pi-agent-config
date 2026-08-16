import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedSandboxConfig, SandboxBackendMode } from "./config.ts";
import type { EnvironmentStoreStatus } from "./environments/store.ts";
import type { EnvironmentPlan, RequestedEnvironment } from "./environments/types.ts";

export const STATUS_KEY = "sandbox";

export type EffectiveSandboxBackend = Exclude<SandboxBackendMode, "auto">;

export type SandboxState =
  | {
      mode: "starting" | "bypass" | "blocked";
      reason: string;
      loaded?: LoadedSandboxConfig;
      requestedBackend?: SandboxBackendMode;
      effectiveBackend?: never;
      environmentPlan?: EnvironmentPlan;
    }
  | {
      mode: "sandboxed";
      reason: string;
      loaded: LoadedSandboxConfig;
      requestedBackend: SandboxBackendMode;
      effectiveBackend: EffectiveSandboxBackend;
      environmentPlan?: EnvironmentPlan;
    };

export function setStatus(ctx: ExtensionContext, state: SandboxState): void {
  if (!ctx.hasUI) return;
  const status = state.mode === "sandboxed"
    ? ctx.ui.theme.fg("success", " sandbox on")
    : state.mode === "blocked"
      ? ctx.ui.theme.fg("error", " sandbox blocked")
      : ctx.ui.theme.fg("warning", " sandbox off");
  ctx.ui.setStatus(STATUS_KEY, status);
}

export function formatEnvironmentStoreStatus(
  status: EnvironmentStoreStatus,
  detailed: boolean,
): string {
  const lines = [
    "Environment store",
    `  Objects: ${status.objects}`,
    `  Size: ${formatBytes(status.bytes)}`,
    `  Leased: ${status.leasedObjects}`,
  ];
  if (detailed) {
    lines.push("  Installed:");
    if (status.installed.length === 0) lines.push("    (none)");
    for (const entry of status.installed) {
      lines.push(
        `    ${entry.profile}@${entry.version} (${entry.platform}, ${formatBytes(entry.bytes)}${entry.leased ? ", active" : ""})`,
      );
    }
  }
  return lines.join("\n");
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function formatState(
  state: SandboxState,
  readGrants: string[] = [],
  writeGrants: string[] = [],
  approvedHostExecWords: ReadonlySet<string> = new Set(),
  approvedNetworkDomains: ReadonlySet<string> = new Set(),
): string {
  const lines = [
    `Sandbox: ${state.mode}`,
    `Reason: ${state.reason}`,
  ];
  const loaded = state.loaded;
  if (!loaded) return lines.join("\n");

  const config = loaded.config;
  const usesAppleContainer = state.effectiveBackend === "apple-container";
  lines.push(
    `Configuration: ${loaded.loadedFrom.join(", ") || "built-in defaults"}`,
    `Requested backend: ${state.requestedBackend ?? "not resolved"}`,
    `Effective backend: ${state.effectiveBackend ?? "not active"}`,
    "",
    "Isolation:",
    `  Host launcher: ${usesAppleContainer ? "trusted fixed argv (Apple XPC is incompatible with Seatbelt)" : "ASRT (Seatbelt/bubblewrap)"}`,
    `  Apple Container VM: ${usesAppleContainer ? "enabled" : "disabled"}`,
    `  Guest process: ${usesAppleContainer ? "ASRT (bubblewrap + proxy; VM isolates host IPC)" : "not applicable"}`,
    `  Workspace: ${usesAppleContainer ? config.isolation.appleContainer.workspaceMode : "direct"}`,
    `  Policy parity: ${usesAppleContainer ? "strict (transactional workspace)" : "process backend"}`,
    "",
    "Development environments:",
    ...(state.environmentPlan?.profiles.length
      ? state.environmentPlan.profiles.map((profile) => (
          `  ${profile.id}: ${profile.version} (${profile.source}, ${state.environmentPlan?.platform})`
        ))
      : ["  (none)"]),
    "",
    "Network:",
    `  Allowed domains: ${config.network.allowedDomains.join(", ") || "(none)"}`,
    `  Denied domains: ${config.network.deniedDomains.join(", ") || "(none)"}`,
    `  Prompt for unlisted domains: ${config.network.strictAllowlist === true ? "disabled" : "enabled"}`,
    `  Session domain grants: ${[...approvedNetworkDomains].join(", ") || "(none)"}`,
    `  Local binding: ${config.network.allowLocalBinding === true ? "allowed" : "blocked"}`,
    "",
    "Filesystem:",
    `  Deny read: ${config.filesystem.denyRead.join(", ") || "(none)"}`,
    `  Baseline allow read: ${config.filesystem.allowRead?.join(", ") || "(none)"}`,
    `  Session read grants: ${readGrants.join(", ") || "(none)"}`,
    `  Baseline allow write: ${config.filesystem.allowWrite.join(", ") || "(none)"}`,
    `  Session write grants: ${writeGrants.join(", ") || "(none)"}`,
    `  Deny write: ${config.filesystem.denyWrite.join(", ") || "(none)"}`,
    "",
    "Host execution (after approval):",
    `  Extra command prefixes: ${config.hostExec?.commands?.join(", ") || "(none)"}`,
    `  Approved this session: ${[...approvedHostExecWords].join(", ") || "(none)"}`,
  );
  if (loaded.warnings.length > 0) {
    lines.push("", "Warnings:", ...loaded.warnings.map((warning) => `  ${warning}`));
  }
  return lines.join("\n");
}

export function formatEnvironmentRequests(requests: RequestedEnvironment[]): string {
  return requests
    .map((request) => `${request.id}@${request.requestedVersion ?? "unspecified"}`)
    .join(", ");
}
