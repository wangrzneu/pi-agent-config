import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadMarkdownFile, MarkdownFileError } from "./markdown-loader.ts";
import { MarkdownViewer } from "./markdown-viewer.ts";

async function openMarkdown(argument: string, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    const message = "Markdown viewer is only available in interactive TUI mode.";
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else process.stderr.write(`${message}\n`);
    return;
  }

  let file;
  try {
    file = await loadMarkdownFile(argument, ctx.cwd);
  } catch (error) {
    const message =
      error instanceof MarkdownFileError ? error.message : "Unable to open the Markdown file.";
    ctx.ui.notify(message, "error");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    return new MarkdownViewer(tui, theme, file.path, file.content, () => done());
  });
}

export default function markdownViewer(pi: ExtensionAPI): void {
  const command = {
    description: "Open and render a local Markdown file",
    handler: openMarkdown,
  };

  pi.registerCommand("md", command);
  pi.registerCommand("markdown", command);
}
