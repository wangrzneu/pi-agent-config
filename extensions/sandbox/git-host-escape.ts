/**
 * Detect git commands that touch a remote (push, pull, fetch, clone,
 * ls-remote) in a bash command line.
 *
 * These operations need network and, for https remotes, Keychain
 * credentials — both restricted inside the sandbox. They are promoted to
 * host execution after explicit user confirmation instead of failing inside
 * the sandbox.
 *
 * Matching is segment-based and conservative: only the first command segment
 * of the line is considered, supporting subcommands like `git push ...`,
 * `git -C <dir> fetch` (with or without options before the subcommand), and
 * an absolute/normalized `git` binary path. Anything unrecognized is left
 * untouched so tooling (for example wrapper scripts) still runs in the
 * sandbox as before.
 */
export function isRemoteGitCommand(command: string): boolean {
  const firstSegment = command.trim().split(/\s*[;&|]\s*/, 1)[0];
  if (!firstSegment) return false;

  // git [-C dir] [-c key=value] ... <push|pull|fetch|clone|ls-remote>
  const remotePattern =
    /^(?:[\w./@+-]+\/)*git(?:\s+-(?:C|c|p|s|b)\s+\S+)*\s+(?:push|pull|fetch|clone|ls-remote)(?:\s|$)/;
  return remotePattern.test(firstSegment);
}
