/**
 * Project identity for external memory.
 *
 * Monospace rule: memory must never be searched across projects by default.
 * The project key is derived in this order:
 *   1. Explicit `projectId` from project configuration.
 *   2. A normalized Git remote identity plus a short hash.
 *   3. A normalized working-directory identity plus a short hash.
 *
 * The stored key combines a readable slug with a collision-resistant suffix.
 * Raw absolute paths and credentials embedded in remotes must never appear in
 * the folder name or recalled evidence.
 */

import { createHash } from "node:crypto";

const SLUG_SEPARATOR = "-";
const MAX_SLUG_LENGTH = 48;

/** A UF8-normalized, slugified identifier used for path components. */
export interface ProjectIdentity {
  key: string;
  slug: string;
  suffix: string;
  source: "explicit" | "git" | "directory";
}

/**
 * Normalize a slug for use in a directory component: keep URL-safe readable
 * characters, collapse separators, and drop characters that could be used for
 * traversal or lookalike confusion.
 */
export function slugify(value: string, maxLength = MAX_SLUG_LENGTH): string {
  const normalized = value.normalize("NFKC");
  const cleaned = normalized
    // Unicode lookalike separators (e.g. full-width slash, ideographic full stop)
    .replace(/[\u2215\uFF0F\uFF3C\uFF0E\u2024\u3002]/g, SLUG_SEPARATOR)
    // disallowed characters down to '-'
    .replace(/[^a-zA-Z0-9._~-]+/g, SLUG_SEPARATOR)
    .replace(SLUG_SEPARATOR + "+", SLUG_SEPARATOR)
    .replace(/^[._~-]+|[._~-]+$/g, "")
    .toLowerCase();
  if (!cleaned) return "project";
  return cleaned.slice(0, maxLength);
}

function shortHash(value: string, length = 8): string {
  return createHash("sha256").update(value.normalize("NFKC")).digest("hex").slice(0, length);
}

function stripRemoteCredentials(remote: string): string {
  // https://user:pass@host/path -> https://host/path
  let stripped = remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
  // ssh://git@host/path -> ssh://host/path ; git@host:path -> host:path
  stripped = stripped.replace(/^ssh:\/\/[^@/]+@/i, "ssh://");
  stripped = stripped.replace(/^[^/@]+@([^:]+):/, "$1:");
  return stripped.trim();
}

/** Normalize a Git remote to a stable identity, ignoring transport/credentials. */
export function normalizeGitRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (!trimmed) return undefined;
  const stripped = stripRemoteCredentials(trimmed);

  // Retain only the meaningful host+path. Drop any trailing ".git".
  const withoutSuffix = stripped.replace(/\.git$/i, "");

  // For scp-like syntax (host:path), normalise the leading "git@".
  const scpLike = withoutSuffix.includes("://")
    ? null
    : withoutSuffix.match(/^([^/]+):(.+)$/);
  if (scpLike && !scpLike[1].includes("/")) {
    return `${scpLike[1]}/${scpLike[2]}`;
  }
  // URL forms: drop the scheme prefix, keep host/path.
  const urlLike = withoutSuffix.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/]+)(\/.*)?$/i);
  if (urlLike) {
    return `${urlLike[1].toLowerCase()}${urlLike[2] ?? ""}`;
  }
  return withoutSuffix;
}

/** Working-directory identity: a normalized basename + suffix for uniqueness. */
export function directoryIdentity(cwd: string): ProjectIdentity {
  const normalized = cwd.normalize("NFKC");
  const basename = normalized.split(/[\\/]+/).filter(Boolean).at(-1) ?? "project";
  const slug = slugify(basename) || "project";
  const suffix = shortHash(normalized, 8);
  return { key: `${slug}${SLUG_SEPARATOR}${suffix}`, slug, suffix, source: "directory" };
}

/**
 * Derive the project key.
 * - explicit: the raw configured ID is validated; stored slugged + hashed so a
 *   malicious configured projectId cannot escape the project directory.
 * - git remote: normalized identity + 8-char hash.
 * - cwd fallback: basename + cwd hash.
 */
export function deriveProjectKey(
  projectId: string | undefined,
  gitRemote: string | undefined,
  cwd: string,
): ProjectIdentity {
  if (projectId && projectId.trim()) {
    const slug = slugify(projectId) || "project";
    // Include a short hash of the canonical value so distinct explicit IDs keep
    // distinct keys even when they slugify the same way.
    const suffix = shortHash(`explicit:${projectId}`, 8);
    return { key: `${slug}${SLUG_SEPARATOR}${suffix}`, slug, suffix, source: "explicit" };
  }

  const normalized = gitRemote ? normalizeGitRemote(gitRemote) : undefined;
  if (normalized) {
    const slug = slugify(normalized) || "repository";
    const suffix = shortHash(`git:${normalized}`, 8);
    return { key: `${slug}${SLUG_SEPARATOR}${suffix}`, slug, suffix, source: "git" };
  }

  return directoryIdentity(cwd);
}

/**
 * Validate an external identifier for use as a single path component.
 * Returns the safe component, or throws when the identifier would escape.
 */
export function safeComponent(value: string, label: string): string {
  const normalized = value.normalize("NFKC");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    /[\u2028\u2029]/.test(normalized)
  ) {
    throw new Error(`Invalid ${label}: identifier contains unsupported characters.`);
  }
  // Also reject Unicode lookalike separators outright for identifiers.
  if (/[\u2215\uFF0F\uFF3C\uFF0E\u2024\u3002]/.test(normalized)) {
    throw new Error(`Invalid ${label}: identifier contains lookalike separators.`);
  }
  return normalized;
}

/** True when the byte length stays within a safe limit for path components. */
export function verifyIdentifierLength(value: string, maxBytes = 120): boolean {
  return Buffer.byteLength(value, "utf8") <= maxBytes;
}
