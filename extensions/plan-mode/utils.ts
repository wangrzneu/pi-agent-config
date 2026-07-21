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
  /(^|\s)-(?:exec|execdir|delete|ok|okdir)(?:\s|$)/;

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

  return true;
}

export function extractPlan(text: string): string[] {
  const match = text.match(/(?:^|\n)Plan:\s*\n([\s\S]*?)(?:\n\n|$)/i);
  if (!match) return [];

  return [...match[1].matchAll(/^\s*\d+[.)]\s+(.+)$/gm)]
    .map((item) => item[1].trim());
}
