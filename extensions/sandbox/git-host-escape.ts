/**
 * Detect git commands that touch a remote (push, pull, fetch, clone,
 * ls-remote, submodule update) in a bash command line.
 *
 * These operations need network and, for https remotes, Keychain
 * credentials — both restricted inside the sandbox. They are promoted to
 * host execution after explicit user confirmation instead of failing inside
 * the sandbox.
 *
 * Matching segments the whole line by &&/;/| (respecting quotes), so
 * `cd /repo && git push` and `echo hi; git fetch` are detected, not just a
 * leading `git push`. A `bash -c "..."` (or sh -c) wrapper is unwrapped once
 * and its quoted content checked recursively, so `bash -c "git push"` works.
 * Literal strings inside plain echo/printf arguments are not treated as
 * commands, which avoids false positives.
 */
export function isRemoteGitCommand(command: string): boolean {
  for (const segment of splitCommandSegments(command)) {
    if (isRemoteGitSegment(segment)) return true;
    const inner = unwrapShellC(segment);
    if (inner !== undefined && isRemoteGitCommand(inner)) return true;
  }
  return false;
}

const GIT_BIN_PREFIX = "(?:[\\w./@+-]+/)*git";
const GIT_OPTIONS = "(?:\\s+-(?:C|c|p|s|b)\\s+\\S+)*";
const REMOTE_SUBCOMMANDS = "(?:push|pull|fetch|clone|ls-remote|submodule\\s+update)";
const REMOTE_PATTERN = new RegExp(
  `^${GIT_BIN_PREFIX}${GIT_OPTIONS}\\s+${REMOTE_SUBCOMMANDS}(?:\\s|$)`,
);

function isRemoteGitSegment(segment: string): boolean {
  return REMOTE_PATTERN.test(segment);
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
