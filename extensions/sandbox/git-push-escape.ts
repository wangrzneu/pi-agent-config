/**
 * Detect `git push` invocations in a bash command line.
 *
 * The sandbox blocks Keychain access, so `git push` over https cannot
 * authenticate (osxkeychain returns nothing). These commands are promoted to
 * host execution after explicit user confirmation instead of failing inside
 * the sandbox.
 *
 * Matching is segment-based and conservative: only the first command segment
 * of the line is considered, supporting `git push ...`, `git -C <dir> push`
 * (with or without options before the subcommand), and an absolute/normalized
 * `git` binary path. Anything unrecognized is left untouched so tooling (for
 * example wrapper scripts) still runs in the sandbox as before.
 */
export function isGitPushCommand(command: string): boolean {
  const firstSegment = command.trim().split(/\s*[;&|]\s*/, 1)[0];
  if (!firstSegment) return false;

  // git [-C dir] [-c key=value] ... push
  const pushPattern =
    /^(?:[\w./@+-]+\/)*git(?:\s+-(?:C|c|p|s|b)\s+\S+)*\s+push(?:\s|$)/;
  return pushPattern.test(firstSegment);
}
