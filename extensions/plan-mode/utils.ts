const SAFE_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "grep", "find", "rg", "fd",
  "ls", "pwd", "tree", "git", "npm", "yarn", "pnpm", "uname", "whoami",
  "date", "uptime",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse",
]);

const UNSAFE_ARGUMENTS =
  /(^|\s)(?:-D|-d|--delete|--move|--output(?:=|\s)|-o(?:=|\s)|--exec(?:=|\s)|--ext-diff|--textconv|--no-index)(?:\s|$)/;

const FIND_MUTATION_FLAGS =
  /(^|\s)-(?:exec|execdir|delete|ok|okdir|fprint0?|fprintf|fls)(?:\s|$)/;

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[\r\n\0\\;&|<>\x60$(){}'"]/.test(trimmed)) return false;

  const executable = trimmed.split(/\s+/)[0];
  if (!SAFE_COMMANDS.has(executable)) return false;

  if (executable === "git") {
    const tokens = trimmed.split(/\s+/);
    return SAFE_GIT_SUBCOMMANDS.has(tokens[1]) && !UNSAFE_ARGUMENTS.test(trimmed);
  }

  if (["npm", "yarn", "pnpm"].includes(executable)) {
    return /^(npm|yarn|pnpm)\s+(list|outdated|info)(\s|$)/.test(trimmed);
  }

  if (executable === "find") return !FIND_MUTATION_FLAGS.test(trimmed);
  if (executable === "tree") return !/(^|\s)-o(?:\s|=)/.test(trimmed);
  if (executable === "less" || executable === "more") {
    return !/(^|\s)-[oO](?:\s|=)/.test(trimmed);
  }
  if (executable === "date") return !/(^|\s)(?:-s|--set)(?:\s|=)/.test(trimmed);
  if (executable === "rg") return !/(^|\s)--pre(?:\s|=)/.test(trimmed);
  if (executable === "fd") {
    return !/(^|\s)(?:-x|-X|--exec|--exec-batch)(?:\s|=|$)/.test(trimmed);
  }

  return true;
}

export function extractPlan(text: string): string[] {
  // Use the last "Plan:" section: reasoning-mode models may draft an earlier
  // plan in a thinking block before producing the visible final plan.
  const headers = [...text.matchAll(/(?:^|\n)\s*(?:\*\*)?Plan:(?:\*\*)?\s*\n/gi)];
  if (headers.length === 0) return [];

  const last = headers.at(-1)!;
  const section = text.slice((last.index ?? 0) + last[0].length);
  const steps: string[] = [];

  for (const line of section.split("\n")) {
    if (!line.trim()) {
      if (steps.length > 0) break;
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numbered) {
      steps.push(
        numbered[1]
          .replace(/\*\*/g, "")
          .replace(/`/g, "")
          .trim(),
      );
      continue;
    }
    // Stop at prose or a bullet after the numbered list, so an unrelated list
    // later in the message is not captured as plan progress.
    if (steps.length > 0 && !/^\s*[-*]\s+/.test(line)) break;
  }

  return steps;
}
