import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SANDBOX_TEMP_ROOT } from "./sandbox-paths.ts";
import { errorMessage } from "./util.ts";

export type SandboxBackendMode = "auto" | "process" | "apple-container";
export type EnvironmentInstallMode = "never" | "ask" | "auto";
export type EnvironmentProfileSource = "auto" | "local" | "managed";

interface RuntimeEnvironmentProfileConfig {
  version?: string;
  source: EnvironmentProfileSource;
}

export interface DevelopmentEnvironmentsConfig {
  promptOnStart: boolean;
  selected: string[];
  install: {
    mode: EnvironmentInstallMode;
    maxSize: string;
    retentionDays: number;
  };
  profiles: {
    go: RuntimeEnvironmentProfileConfig;
    python: RuntimeEnvironmentProfileConfig;
    node: RuntimeEnvironmentProfileConfig;
    pnpm: {
      version?: string;
      storeScope: "project" | "global";
    };
    kubectl: RuntimeEnvironmentProfileConfig;
  };
}

export interface KubernetesConfig {
  promptOnStart: boolean;
  defaultAccess: "observe" | "rbac";
  defaultNamespaces: "context" | "all";
  persistContextSelection: boolean;
  credentialMode: "host-broker";
}

export interface AppleContainerConfig {
  binary: string;
  image: string;
  platform: "linux/arm64";
  shell: string;
  cpus: number;
  memory: string;
  pullPolicy: "never";
  workspaceMode: "transactional-apfs";
}

export interface SandboxConfig extends SandboxRuntimeConfig {
  enabled: boolean;
  isolation: {
    mode: SandboxBackendMode;
    appleContainer: AppleContainerConfig;
  };
  /**
   * Commands that always run on the host (after session-level approval) because
   * their default configuration lives in `~`-homed credential files that the
   * sandbox denies. Matched by exact first command word. Remote git and `gh`
   * are always matched by the built-in detectors and do not need to be listed.
   */
  hostExec?: { commands?: string[] };
  developmentEnvironments: DevelopmentEnvironmentsConfig;
  kubernetes: KubernetesConfig;
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
      "go.dev",
      "dl.google.com",
      "dl.k8s.io",
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
  isolation: {
    // Auto-select the additional Apple VM layer when every prerequisite is
    // available. Otherwise startup reports the failed check and safely falls
    // back to the Process sandbox; it never falls back to an unsandboxed shell.
    mode: "auto",
    appleContainer: {
      binary: "/opt/homebrew/bin/container",
      image: "local/pi-sandbox-asrt:0.0.70",
      platform: "linux/arm64",
      shell: "/bin/bash",
      cpus: 2,
      memory: "2g",
      pullPolicy: "never",
      workspaceMode: "transactional-apfs",
    },
  },
  developmentEnvironments: {
    promptOnStart: true,
    selected: [],
    install: {
      mode: "ask",
      maxSize: "5g",
      retentionDays: 30,
    },
    profiles: {
      go: { source: "auto" },
      python: { source: "auto" },
      node: { source: "auto" },
      pnpm: { storeScope: "project" },
      kubectl: { source: "auto" },
    },
  },
  kubernetes: {
    promptOnStart: true,
    defaultAccess: "observe",
    defaultNamespaces: "context",
    persistContextSelection: false,
    credentialMode: "host-broker",
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
  validateSandboxOverrides(overrides);

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
  mergeDevelopmentEnvironmentConfig(merged, overrides.developmentEnvironments);
  if (isRecord(overrides.kubernetes)) {
    merged.kubernetes = {
      ...merged.kubernetes,
      ...structuredClone(overrides.kubernetes),
    } as KubernetesConfig;
  }

  if (isRecord(overrides.isolation)) {
    const isolation = overrides.isolation;
    const appleContainer = isRecord(isolation.appleContainer)
      ? isolation.appleContainer
      : undefined;
    if (isolation.mode !== undefined) {
      merged.isolation.mode = structuredClone(isolation.mode) as SandboxBackendMode;
    } else if (appleContainer?.enabled !== undefined) {
      // Compatibility with the original `isolation.appleContainer.enabled`
      // setting. New configuration should use the backend domain concept.
      merged.isolation.mode = legacyAppleContainerMode(appleContainer.enabled);
    }
    if (appleContainer !== undefined) {
      const { enabled: _legacyEnabled, ...containerOverrides } = appleContainer;
      merged.isolation.appleContainer = {
        ...merged.isolation.appleContainer,
        ...structuredClone(containerOverrides),
      } as AppleContainerConfig;
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
    try {
      config = mergeSandboxConfig(config, globalConfig);
      loadedFrom.push(globalPath);
    } catch (error) {
      warnings.push(`Could not apply ${globalPath}: ${errorMessage(error)}`);
    }
  }

  if (projectTrusted) {
    const projectConfig = readConfigFile(projectPath, warnings);
    if (projectConfig !== undefined) {
      try {
        config = mergeSandboxConfig(config, projectConfig);
        loadedFrom.push(projectPath);
      } catch (error) {
        warnings.push(`Could not apply ${projectPath}: ${errorMessage(error)}`);
      }
    }
  } else if (existsSync(projectPath)) {
    warnings.push(`Ignored untrusted project configuration: ${projectPath}`);
  }

  return { config, loadedFrom, warnings };
}

function validateSandboxOverrides(overrides: Record<string, unknown>): void {
  const environments = overrides.developmentEnvironments;
  if (isRecord(environments)) {
    assertOptionalBoolean(environments.promptOnStart, "developmentEnvironments.promptOnStart");
    if (environments.selected !== undefined) {
      if (!Array.isArray(environments.selected) || environments.selected.some((id) => (
        typeof id !== "string" || !["go", "python", "node", "pnpm", "kubectl"].includes(id)
      ))) {
        throw new Error("Invalid developmentEnvironments.selected");
      }
    }
    if (isRecord(environments.install)) {
      assertOptionalEnum(
        environments.install.mode,
        ["never", "ask", "auto"],
        "developmentEnvironments.install.mode",
      );
      if (
        environments.install.maxSize !== undefined
        && (typeof environments.install.maxSize !== "string"
          || !/^\d+(?:\.\d+)?(?:[kmgt]i?b?|b)$/i.test(environments.install.maxSize))
      ) {
        throw new Error("Invalid developmentEnvironments.install.maxSize");
      }
      if (
        environments.install.retentionDays !== undefined
        && (!Number.isInteger(environments.install.retentionDays)
          || Number(environments.install.retentionDays) < 0
          || Number(environments.install.retentionDays) > 3650)
      ) {
        throw new Error("Invalid developmentEnvironments.install.retentionDays");
      }
    }
    if (isRecord(environments.profiles)) {
      for (const id of ["go", "python", "node", "pnpm", "kubectl"] as const) {
        const profile = environments.profiles[id];
        if (!isRecord(profile)) continue;
        if (
          profile.version !== undefined
          && (typeof profile.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(profile.version))
        ) {
          throw new Error(`Invalid developmentEnvironments.profiles.${id}.version`);
        }
        if (id === "pnpm") {
          assertOptionalEnum(
            profile.storeScope,
            ["project", "global"],
            `developmentEnvironments.profiles.${id}.storeScope`,
          );
        } else {
          assertOptionalEnum(
            profile.source,
            ["auto", "local", "managed"],
            `developmentEnvironments.profiles.${id}.source`,
          );
        }
      }
    }
  }

  const kubernetes = overrides.kubernetes;
  if (isRecord(kubernetes)) {
    assertOptionalBoolean(kubernetes.promptOnStart, "kubernetes.promptOnStart");
    assertOptionalBoolean(kubernetes.persistContextSelection, "kubernetes.persistContextSelection");
    assertOptionalEnum(kubernetes.defaultAccess, ["observe", "rbac"], "kubernetes.defaultAccess");
    assertOptionalEnum(kubernetes.defaultNamespaces, ["context", "all"], "kubernetes.defaultNamespaces");
    assertOptionalEnum(kubernetes.credentialMode, ["host-broker"], "kubernetes.credentialMode");
  }
}

function assertOptionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`Invalid ${path}`);
}

function assertOptionalEnum(value: unknown, allowed: readonly string[], path: string): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    throw new Error(`Invalid ${path}: ${JSON.stringify(value)}`);
  }
}

function mergeDevelopmentEnvironmentConfig(
  target: SandboxConfig,
  override: unknown,
): void {
  if (!isRecord(override)) return;
  const current = target.developmentEnvironments;
  if (typeof override.promptOnStart === "boolean") {
    current.promptOnStart = override.promptOnStart;
  }
  if (Array.isArray(override.selected)) {
    current.selected = structuredClone(override.selected) as string[];
  }
  if (isRecord(override.install)) {
    current.install = {
      ...current.install,
      ...structuredClone(override.install),
    } as DevelopmentEnvironmentsConfig["install"];
  }
  if (isRecord(override.profiles)) {
    for (const id of ["go", "python", "node", "pnpm", "kubectl"] as const) {
      const profileOverride = override.profiles[id];
      if (!isRecord(profileOverride)) continue;
      current.profiles[id] = {
        ...current.profiles[id],
        ...structuredClone(profileOverride),
      } as never;
    }
  }
}

function legacyAppleContainerMode(value: unknown): SandboxBackendMode {
  if (value === true) return "apple-container";
  if (value === false) return "process";
  if (value === "auto") return "auto";
  return value as SandboxBackendMode;
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
