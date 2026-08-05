import { execFileSync } from "node:child_process";

export interface GitIdentity {
  name: string;
  email: string;
}

type GitConfigGetter = (key: string) => string | undefined;

const defaultGetter: GitConfigGetter = (key) => {
  try {
    const value = execFileSync(
      "git",
      ["config", "--global", "--get", key],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Read the user's global git identity on the host side. The sandboxed child
 * shells cannot read ~/.gitconfig (home reads are denied), so this is loaded
 * here and injected into child environments. Returns undefined when no
 * identity is configured (git then falls back to its default username and
 * hostname identity).
 */
export function loadGitIdentity(
  get: GitConfigGetter = defaultGetter,
): GitIdentity | undefined {
  const name = readKey(get, "user.name");
  const email = readKey(get, "user.email");
  if (!name || !email) return undefined;
  return { name, email };
}

function readKey(get: GitConfigGetter, key: string): string | undefined {
  try {
    return get(key);
  } catch {
    return undefined;
  }
}

/**
 * Environment variables that pin the sandboxed git identity. Two mechanisms:
 * 1. GIT_AUTHOR and GIT_COMMITTER variables — env-level identity override;
 *    always wins for commits.
 * 2. GIT_CONFIG_COUNT, GIT_CONFIG_KEY-n, GIT_CONFIG_VALUE-n — env-level
 *    config injection, so `git config user.name` also reports the inherited
 *    identity. Key numbers continue from any existing GIT_CONFIG_COUNT in
 *    `baseEnv` (the actual child environment this is merged into), so entries
 *    injected by the sandbox runtime (for example safe.directory) are kept.
 */
export function gitIdentityEnv(
  identity: GitIdentity | undefined,
  baseEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  if (!identity) return {};
  const { name, email } = identity;
  const start = parseCount(baseEnv.GIT_CONFIG_COUNT);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_COUNT: String(start + 2),
    [`GIT_CONFIG_KEY_${start}`]: "user.name",
    [`GIT_CONFIG_VALUE_${start}`]: name,
    [`GIT_CONFIG_KEY_${start + 1}`]: "user.email",
    [`GIT_CONFIG_VALUE_${start + 1}`]: email,
  };
}

function parseCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
