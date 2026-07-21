const SAFE_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "grep", "find", "rg", "fd",
  "ls", "pwd", "tree", "git", "npm", "yarn", "pnpm", "uname", "whoami",
  "date", "uptime",
]);

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[;&|<>`$]/.test(trimmed)) return false;

  const executable = trimmed.split(/\s+/)[0];
  if (!SAFE_COMMANDS.has(executable)) return false;

  if (executable === "git") {
    return /^(git\s+(status|log|diff|branch|show|rev-parse)(\s|$))/.test(trimmed);
  }

  if (["npm", "yarn", "pnpm"].includes(executable)) {
    return /^(npm|yarn|pnpm)\s+(list|outdated|info)(\s|$)/.test(trimmed);
  }

  return true;
}

export function extractPlan(text: string): string[] {
  const match = text.match(/(?:^|\n)Plan:\s*\n([\s\S]*?)(?:\n\n|$)/i);
  if (!match) return [];

  return [...match[1].matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)]
    .map((item) => item[2].trim());
}
