import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SANDBOX_TEMP_ROOT } from "./sandbox-paths.ts";
import { errorMessage } from "./util.ts";

export interface SandboxConfig extends SandboxRuntimeConfig {
  enabled: boolean;
  /**
   * Commands that always run on the host (after session-level approval) because
   * their default configuration lives in `~`-homed credential files that the
   * sandbox denies. Matched by exact first command word. Remote git and `gh`
   * are always matched by the built-in detectors and do not need to be listed.
   */
  hostExec?: { commands?: string[] };
}

export interface LoadedSandboxConfig {
  config: SandboxConfig;
  loadedFrom: string[];
  warnings: string[];
}

const SYSTEM_READ_PATHS = process.platform === "darwin"
  ? [
      "/System",
      "/usr",
      "/bin",
      "/sbin",
      "/Library",
      "/opt/homebrew",
      "/private/etc",
      "/etc",
      "/dev",
      "/var",
      "/private/var",
      "/tmp",
      "/private/tmp",
      tmpdir(),
      "/Applications/Xcode.app",
    ]
  : [
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
      "/opt",
      "/var/lib",
      tmpdir(),
    ];

const SENSITIVE_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: [
      "github.com",
      "*.github.com",
      "githubusercontent.com",
      "*.githubusercontent.com",
      "npmjs.org",
      "*.npmjs.org",
      "registry.yarnpkg.com",
      "nodejs.org",
      "*.nodejs.org",
      "pypi.org",
      "*.pypi.org",
      "pythonhosted.org",
      "*.pythonhosted.org",
      "crates.io",
      "*.crates.io",
      "rubygems.org",
      "*.rubygems.org",
      "proxy.golang.org",
      "sum.golang.org",
      "storage.googleapis.com",
      "repo.maven.apache.org",
      "plugins.gradle.org",
      "services.gradle.org",
      "downloads.gradle.org",
      "deno.land",
      "*.deno.land",
      "jsr.io",
      "*.jsr.io",
      "nuget.org",
      "*.nuget.org",
    ],
    deniedDomains: [],
    allowLocalBinding: true,
  },
  // macOS: newer Python tools (pip/truststore), Go, gh, gcloud, and others
  // verify TLS certificates through the system trustd service. Without this
  // mach-lookup grant they fail with "certificate verify failed". The grant
  // exposes the trustd service to sandboxed processes; sessions that do not
  // need network TLS verification can set this to false in sandbox.json.
  enableWeakerNetworkIsolation: true,
  filesystem: {
    denyRead: ["/"],
    allowRead: [".", SANDBOX_TEMP_ROOT, ...SYSTEM_READ_PATHS],
    allowWrite: [".", tmpdir(), "/tmp", "/private/tmp", SANDBOX_TEMP_ROOT],
    denyWrite: [
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
      ".env.test",
      "*.pem",
      "*.key",
    ],
  },
  credentials: {
    envVars: SENSITIVE_ENV_VARS.map((name) => ({ name, mode: "deny" as const })),
  },
  hostExec: {
    // Only cloud-CLI tools whose credentials live in `~` files and whose
    // operations are network-bound are promoted to the host by default:
    // - npm/pnpm/yarn are intentionally absent: they have cache/temp
    //   redirections in the sandbox (codingCacheEnvironment) and their registry
    //   traffic is in `allowedDomains`, so plain installs work sandboxed.
    // - ssh/docker are intentionally absent: they are high-privilege escapes
    //   (arbitrary remote command execution / host mounts). They are promoted
    //   only when a user explicitly lists them in sandbox.json.
    commands: ["aws", "gcloud", "az"],
  },
};

const RUNTIME_PASSTHROUGH_KEYS = [
  "ignoreViolations",
  "enableWeakerNestedSandbox",
  "enableWeakerNetworkIsolation",
] as const;

export function mergeSandboxConfig(
  base: SandboxConfig,
  overrides: unknown,
): SandboxConfig {
  if (!isRecord(overrides)) return structuredClone(base);

  const merged = structuredClone(base);
  if (typeof overrides.enabled === "boolean") merged.enabled = overrides.enabled;

  mergeSection(merged, overrides, "network");
  mergeSection(merged, overrides, "filesystem");
  mergeSection(merged, overrides, "credentials");

  for (const key of [...RUNTIME_PASSTHROUGH_KEYS, "hostExec"] as const) {
    if (overrides[key] !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = structuredClone(overrides[key]);
    }
  }

  return merged;
}

export function loadSandboxConfig(
  cwd: string,
  agentDir: string,
  configDirName: string,
  projectTrusted: boolean,
): LoadedSandboxConfig {
  const globalPath = join(agentDir, "extensions", "sandbox.json");
  const projectPath = join(cwd, configDirName, "sandbox.json");
  const loadedFrom: string[] = [];
  const warnings: string[] = [];
  let config = structuredClone(DEFAULT_SANDBOX_CONFIG);

  const globalConfig = readConfigFile(globalPath, warnings);
  if (globalConfig !== undefined) {
    config = mergeSandboxConfig(config, globalConfig);
    loadedFrom.push(globalPath);
  }

  if (projectTrusted) {
    const projectConfig = readConfigFile(projectPath, warnings);
    if (projectConfig !== undefined) {
      config = mergeSandboxConfig(config, projectConfig);
      loadedFrom.push(projectPath);
    }
  } else if (existsSync(projectPath)) {
    warnings.push(`Ignored untrusted project configuration: ${projectPath}`);
  }

  return { config, loadedFrom, warnings };
}

function mergeSection(
  target: SandboxConfig,
  source: Record<string, unknown>,
  key: "network" | "filesystem" | "credentials",
): void {
  const override = source[key];
  if (!isRecord(override)) return;
  const current = target[key];
  target[key] = {
    ...(isRecord(current) ? current : {}),
    ...structuredClone(override),
  } as never;
}

function readConfigFile(
  path: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("top-level JSON value must be an object");
    return parsed;
  } catch (error) {
    warnings.push(`Could not load ${path}: ${errorMessage(error)}`);
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
