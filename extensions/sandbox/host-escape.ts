/**
 * Detect commands that must run on the host instead of inside the sandbox.
 *
 * Built-in always-matched detectors:
 * - git commands that touch a remote (push, pull, fetch, clone, ls-remote,
 *   submodule update)
 * - gh (GitHub CLI) invocations — every gh subcommand talks to api.github.com
 *   and needs the user's gh auth token / Keychain, which are restricted
 *   inside the sandbox
 *
 * Plus a configurable list of exact command-word prefixes (e.g. `aws`,
 * `gcloud`, `docker`, `npm`, `ssh`) for tools whose default config points at
 * `~`-homed credential files. These are matched on the first command word
 * only, so `aws s3 ls` matches but `echo aws` does not.
 *
 * These operations need network and host credentials (Keychain, shell config,
 * ~/.aws, ...) — both restricted inside the sandbox. They are promoted to
 * host execution after explicit user confirmation instead of failing inside
 * the sandbox.
 *
 * Matching segments the whole line by &&/;/| (respecting quotes), so
 * `cd /repo && git push` and `echo hi; git fetch` are detected, not just a
 * leading `git push`. Leading command wrappers (`sudo`, `nohup`, `command`,
 * `exec`, `env KEY=VAL`) are stripped so `sudo gh pr create` and
 * `sudo git push` are detected too. A `bash -c "..."` (or sh -c) wrapper is
 * unwrapped once and its quoted content checked recursively, so
 * `bash -c "git push"` works. Literal strings inside plain echo/printf
 * arguments are not treated as commands, which avoids false positives.
 *
 * Returns the matched command word (for session-level approval memory) or
 * `undefined` when the command can stay in the sandbox.
 */
export type HostExecMatch = {
  /** The stripped first command word that matched (e.g. `aws`, `git`, `gh`). */
  word: string;
};

export function matchHostExecCommand(
  command: string,
  extraPrefixes: readonly string[] = [],
): HostExecMatch | undefined {
  for (const segment of splitCommandSegments(command)) {
    const match = matchHostExecSegment(segment, extraPrefixes);
    if (match !== undefined) return match;
    const inner = unwrapShellC(segment);
    if (inner !== undefined) {
      const match = matchHostExecCommand(inner, extraPrefixes);
      if (match !== undefined) return match;
    }
  }
  return undefined;
}

function matchHostExecSegment(
  segment: string,
  extraPrefixes: readonly string[] = [],
): HostExecMatch | undefined {
  // Commands are often wrapped: `sudo git push`, `nohup gh pr create`,
  // `env GH_TOKEN=x gh auth status`, `command git fetch`. Strip the leading
  // wrapper so the wrapped command is still detected.
  const stripped = stripCommandWrappers(segment);
  const gitRemote = matchRemoteGitSegment(stripped);
  if (gitRemote !== undefined) return gitRemote;
  const gh = matchGhSegment(stripped);
  if (gh !== undefined) return gh;
  return matchExtraPrefixSegment(stripped, extraPrefixes);
}

function matchRemoteGitSegment(segment: string): HostExecMatch | undefined {
  return REMOTE_PATTERN.test(segment) ? { word: "git" } : undefined;
}

function matchGhSegment(segment: string): HostExecMatch | undefined {
  return GH_PATTERN.test(segment) ? { word: "gh" } : undefined;
}

/**
 * Match a configured exact command-word prefix (e.g. `aws`, `gcloud`,
 * `docker`). Only the first command word is matched, so `echo aws s3` is not
 * treated as a host command. A bare `bash -c "..."` inner command is handled
 * by the recursion in {@link matchHostExecCommand}.
 */
function matchExtraPrefixSegment(
  segment: string,
  extraPrefixes: readonly string[],
): HostExecMatch | undefined {
  if (extraPrefixes.length === 0) return undefined;
  const first = segment.split(/\s+/, 1)[0] ?? "";
  const word = first.split("/").pop() ?? first;
  return extraPrefixes.includes(word) ? { word } : undefined;
}

const GIT_BIN_PREFIX = "(?:[\\w./@+-]+/)*git";
const GIT_OPTIONS = "(?:\\s+-(?:C|c|p|s|b)\\s+\\S+)*";
const REMOTE_SUBCOMMANDS = "(?:push|pull|fetch|clone|ls-remote|submodule\\s+update)";
const REMOTE_PATTERN = new RegExp(
  `^${GIT_BIN_PREFIX}${GIT_OPTIONS}\\s+${REMOTE_SUBCOMMANDS}(?:\\s|$)`,
);

// gh (GitHub CLI): every subcommand (pr, issue, repo, api, auth, run, ...) is a
// network operation against api.github.com. `/usr/local/bin/gh ...` works too;
// `mygh ...` and `echo gh` do not match.
const GH_PATTERN = new RegExp("^[\\w./@+-]+/gh(?:\\s|$)|^gh(?:\\s|$)");

function isRemoteGitSegment(segment: string): boolean {
  return REMOTE_PATTERN.test(segment);
}

function isGhSegment(segment: string): boolean {
  return GH_PATTERN.test(segment);
}

/**
 * Strip leading command wrappers (`sudo`, `nohup`, `command`, `exec`, `env
 * KEY=VAL ...`) from a segment so wrapped commands are recognized. Repeats up
 * to a few times so nested wrappers (`sudo nohup git push`) resolve too.
 *
 * Option flags after a wrapper keyword are skipped. `sudo` option flags that
 * consume their own argument (`-u user`, `-g group`, `-p prompt`, ...) are
 * skipped together with that argument; other wrappers' flags are skipped
 * individually. Anything else ends the scan at the command word.
 */
export function stripCommandWrappers(command: string): string {
  let stripped = command.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = stripOnce(stripped);
    if (next === stripped) return stripped;
    stripped = next;
  }
  return stripped;
}

const SUDO_ARGUMENT_FLAGS = new Set([
  "-u", "-g", "-p", "-h", "-U", "-R", "-r", "-t", "-T", "-C", "-D",
]);

/** Strip a single wrapper keyword and its flags from the front of a command. */
function stripOnce(segment: string): string {
  const words = segment.split(/\s+/);
  const n = words.length;
  let i = 0;
  while (i < n) {
    const word = words[i];
    if (word === "env") {
      i += 1;
      while (i < n && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
      i = skipFlags(words, i, n, false);
      continue;
    }
    if (word === "sudo" || word === "nohup" || word === "command" || word === "exec") {
      i = skipFlags(words, i + 1, n, word === "sudo");
      continue;
    }
    break;
  }
  return words.slice(i).join(" ");
}

function skipFlags(
  words: readonly string[],
  start: number,
  end: number,
  sudo: boolean,
): number {
  let i = start;
  while (i < end) {
    const word = words[i];
    if (!word.startsWith("-") || word === "-") break;
    if (sudo && SUDO_ARGUMENT_FLAGS.has(word)) {
      i += 2; // flag plus its argument, e.g. `sudo -u deploy gh ...`
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * Split a shell command line into segments at &&, ;, and | while keeping
 * quoted strings intact (so `&&` inside quotes is not a separator).
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") segments.push(current.trim());
  return segments;
}

/**
 * If a segment is a `bash/sh -c <quoted command>` invocation, return the
 * quoted command; otherwise undefined. Handles combined short options like
 * `-lc` as well as a standalone `-c`. Other programs that take strings
 * (echo, printf, find -exec) are not unwrapped, so their arguments are not
 * treated as commands.
 */
export function unwrapShellC(segment: string): string | undefined {
  const match = segment.match(
    /^(?:[\w./@+-]+\/)?(?:ba|z|k)?sh(?:\s+-(?![a-zA-Z]*c\s)[a-zA-Z]+)*\s+-[a-zA-Z]*c\s+(['"])(.*?)\1(?:\s|$)/,
  );
  return match?.[2] ?? undefined;
}
