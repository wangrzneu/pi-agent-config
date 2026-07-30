export type WorkType =
  | "design"
  | "plan"
  | "implement"
  | "test"
  | "review"
  | "fix"
  | "explore";

export interface WorkActivity {
  detail: string;
}

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  design: "Design",
  plan: "Plan",
  implement: "Implement",
  test: "Test",
  review: "Review",
  fix: "Fix",
  explore: "Explore",
};

export function summarizeWork(prompt: string, maxWidth = 48): string {
  const normalized = prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[#>*-]+\s*|\d+[.)]\s+)/, "")
    .trim();

  if (!normalized) return "Current task";
  return truncateToDisplayWidth(normalized, maxWidth);
}

export function describeToolActivity(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "bash") {
    return summarizeWork(stringArg(args, "command") || "Running command", 48);
  }

  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    const path =
      stringArg(args, "path") ||
      stringArg(args, "file_path") ||
      stringArg(args, "filePath");
    return path ? `${verbFor(toolName)} ${shortPath(path)}` : `${verbFor(toolName)} file`;
  }

  if (toolName === "grep") {
    const pattern = stringArg(args, "pattern");
    return pattern ? `Searching for ${summarizeWork(pattern, 36)}` : "Searching source";
  }

  if (toolName === "find" || toolName === "ls") {
    const path = stringArg(args, "path");
    return path ? `Exploring ${shortPath(path)}` : "Exploring files";
  }

  return `Running ${toolName.replaceAll("_", " ")}`;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function shortPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return summarizeWork(segments.slice(-2).join("/") || path, 40);
}

function verbFor(toolName: string): string {
  if (toolName === "read") return "Reading";
  if (toolName === "edit") return "Editing";
  return "Writing";
}

function truncateToDisplayWidth(text: string, maxWidth: number): string {
  const totalWidth = Array.from(text).reduce(
    (total, character) => total + displayWidth(character),
    0,
  );
  if (totalWidth <= maxWidth) {
    return text;
  }

  const contentWidth = Math.max(0, maxWidth - 1);
  let width = 0;
  let result = "";

  for (const character of text) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > contentWidth) break;
    result += character;
    width += characterWidth;
  }

  return `${result}…`;
}

function displayWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(character)) return 0;
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}
