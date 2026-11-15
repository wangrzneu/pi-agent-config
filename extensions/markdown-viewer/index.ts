import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DocumentWorkspace } from "./document-workspace.ts";
import { MarkdownFileError } from "./markdown-loader.ts";
import { MarkdownViewer } from "./markdown-viewer.ts";

async function openMarkdown(argument: string, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    const message = "Markdown viewer is only available in interactive TUI mode.";
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else process.stderr.write(`${message}\n`);
    return;
  }

  const workspace = new DocumentWorkspace();
  let document;
  try {
    document = await workspace.open(argument, ctx.cwd);
  } catch (error) {
    const message =
      error instanceof MarkdownFileError ? error.message : "Unable to open the Markdown file.";
    ctx.ui.notify(message, "error");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    return new MarkdownViewer(tui, theme, workspace, document, () => done());
  });
}

function markdownCompletions(prefix: string) {
  const input = prefix.trim();
  const slash = input.lastIndexOf("/");
  const directoryPart = slash >= 0 ? input.slice(0, slash + 1) : "";
  const base = input.slice(directoryPart.length);
  const absoluteDirectory = resolve(process.cwd(), directoryPart || ".");
  try {
    const items = readdirSync(absoluteDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || /\.(md|markdown)$/i.test(entry.name))
      .filter((entry) => entry.name.startsWith(base))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((entry) => ({
        value: `${directoryPart}${entry.name}${entry.isDirectory() ? "/" : ""}`,
        label: entry.name,
        description: entry.isDirectory() ? "directory" : "markdown",
      }));
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

export default function markdownViewer(pi: ExtensionAPI): void {
  const command = {
    description: "Open and render a local Markdown file",
    getArgumentCompletions: markdownCompletions,
    handler: openMarkdown,
  };

  pi.registerCommand("md", command);
  pi.registerCommand("markdown", command);
}
