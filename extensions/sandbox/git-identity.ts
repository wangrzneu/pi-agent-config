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
 * here and injected into child environments as the GIT_AUTHOR and
 * GIT_COMMITTER variables. Returns undefined when no identity is configured
 * (git then falls back to its default username/hostname identity).
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
 * Environment variables that pin a commit's author/committer identity,
 * overriding whatever git could read (or fail to read) inside the sandbox.
 */
export function gitIdentityEnv(identity?: GitIdentity): NodeJS.ProcessEnv {
  if (!identity) return {};
  const { name, email } = identity;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}
