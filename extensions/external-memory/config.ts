/**
 * Configuration and enablement for external memory.
 *
 * - `PI_AGENT_MEMORY_ROOT` must be an absolute path; relative roots are rejected.
 * - `PI_AGENT_MEMORY_PROVIDER` is a display hint only.
 * - Capture remains disabled until the current project opts in via a small file
 *   at `.pi/external-memory.json` (created only after user confirmation).
 * - Configuration values outside supported limits are clamped to documented
 *   bounds; secrets never enter status output.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { deriveProjectKey, type ProjectIdentity } from "./project-identity.ts";
import {
  DEFAULT_PROJECT_CONFIG,
  type ExternalMemoryConfig,
  type ProjectMemoryConfig,
} from "./types.ts";

export const CONFIG_FILE_NAME = "external-memory.json";
export const CONFIG_DIR = ".pi";

export const LIMITS = {
  maxMessageBytes: { min: 1024, max: 16 * 1024 * 1024 },
  maxChunkBytes: { min: 16 * 1024, max: 8 * 1024 * 1024 },
  maxRecallCharacters: { min: 512, max: 100_000 },
  maxResults: { min: 1, max: 50 },
} as const;

export interface ResolvedConfig {
  configured: boolean;
  enabled: boolean;
  root?: string;
  provider?: string;
  project?: ProjectMemoryConfig;
  projectKey?: string;
  projectIdentity?: ProjectIdentity;
  configPath?: string;
  reason?: string;
}

function clamp(value: number | undefined, limits: { min: number; max: number }, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

function normalizeProjectConfig(raw: Partial<ProjectMemoryConfig>): ProjectMemoryConfig {
  const capture = raw.capture === "conversation" ? "conversation" : DEFAULT_PROJECT_CONFIG.capture;
  return {
    enabled: raw.enabled !== false,
    projectId: typeof raw.projectId === "string" && raw.projectId.trim() ? raw.projectId.trim() : undefined,
    capture,
    includeToolResults: raw.includeToolResults === true,
    maxMessageBytes: clamp(raw.maxMessageBytes, LIMITS.maxMessageBytes, DEFAULT_PROJECT_CONFIG.maxMessageBytes),
    maxChunkBytes: clamp(raw.maxChunkBytes, LIMITS.maxChunkBytes, DEFAULT_PROJECT_CONFIG.maxChunkBytes),
    maxRecallCharacters: clamp(
      raw.maxRecallCharacters,
      LIMITS.maxRecallCharacters,
      DEFAULT_PROJECT_CONFIG.maxRecallCharacters,
    ),
  };
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the external memory root from the environment. */
export function resolveRootFromEnv(): string | undefined {
  const root = process.env.PI_AGENT_MEMORY_ROOT?.trim();
  if (!root) return undefined;
  if (!isAbsolute(root)) return undefined; // relative roots rejected
  return root;
}

export function resolveProviderFromEnv(): string | undefined {
  const provider = process.env.PI_AGENT_MEMORY_PROVIDER?.trim().toLowerCase();
  if (!provider) return undefined;
  if (!["icloud", "google-drive", "filesystem"].includes(provider)) return undefined;
  return provider;
}

/** Read the first git remote URL, if any. Never throws. */
export function readGitRemote(cwd: string): string | undefined {
  try {
    const configPath = join(cwd, ".git", "config");
    if (!existsSync(configPath)) return undefined;
    const content = readFileSync(configPath, "utf8");
    // Match each [remote "..."] section; take the first with a url line.
    const sectionPattern = /^\[remote\s+"([^"]+)"\s*\]\s*$/gm;
    const sections: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = sectionPattern.exec(content)) !== null) {
      const start = match.index;
      const next = content.indexOf("[", start + match[0].length);
      sections.push(content.slice(start, next === -1 ? undefined : next));
    }
    for (const section of sections) {
      const urlMatch = section.match(/^\s*url\s*=\s*(.+?)\s*$/m);
      if (urlMatch) return urlMatch[1].trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load and validate external-memory configuration for one project.
 * Never throws; failures produce a `reason` in the result.
 */
export async function loadExternalMemoryConfig(cwd: string): Promise<ResolvedConfig> {
  const root = resolveRootFromEnv();
  if (!root) {
    return { configured: false, enabled: false, reason: "missing-root" };
  }

  const configPath = join(cwd, CONFIG_DIR, CONFIG_FILE_NAME);
  const raw = readJsonFile(configPath);
  if (!raw) {
    return { configured: true, enabled: false, root, reason: "not-opted-in" };
  }

  const project = normalizeProjectConfig(raw as Partial<ProjectMemoryConfig>);
  const gitRemote = readGitRemote(cwd);
  const identity = deriveProjectKey(project.projectId, gitRemote, cwd);

  return {
    configured: true,
    enabled: project.enabled,
    root,
    provider: resolveProviderFromEnv(),
    project,
    projectKey: identity.key,
    projectIdentity: identity,
    configPath,
  };
}

/** Write (or update) the project opt-in file. Failures throw to the caller. */
export async function writeProjectConfig(cwd: string, config: Partial<ProjectMemoryConfig>): Promise<string> {
  const configDir = join(cwd, CONFIG_DIR);
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, CONFIG_FILE_NAME);
  const existing = readJsonFile(configPath) ?? {};
  const merged = { ...existing, ...config };
  const normalized = normalizeProjectConfig(merged as Partial<ProjectMemoryConfig>);
  const payload = normalizeStoragePayload(normalized);
  await writeFile(configPath, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  return configPath;
}

/** Compact storage shape: keep explicit fields; omit undefined projectId. */
function normalizeStoragePayload(config: ProjectMemoryConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    enabled: config.enabled,
    capture: config.capture,
    includeToolResults: config.includeToolResults,
    maxMessageBytes: config.maxMessageBytes,
    maxChunkBytes: config.maxChunkBytes,
    maxRecallCharacters: config.maxRecallCharacters,
  };
  if (config.projectId) payload.projectId = config.projectId;
  return payload;
}

/** Build an ExternalMemoryConfig for the module. */
export function toExternalMemoryConfig(resolved: ResolvedConfig): ExternalMemoryConfig | undefined {
  if (!resolved.configured || !resolved.root || !resolved.project) return undefined;
  return {
    root: resolved.root,
    provider: resolved.provider,
    project: resolved.project,
  };
}

export function defaultProjectConfig(): ProjectMemoryConfig {
  return { ...DEFAULT_PROJECT_CONFIG };
}

export { dirname as configDirname };
