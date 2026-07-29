import { basename } from "node:path";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { ScrollState } from "./scroll-state.ts";

const RESERVED_APP_ROWS = 2;
const VIEWER_FRAME_ROWS = 2;

export class MarkdownViewer implements Component {
  private readonly markdown: Markdown;
  private readonly scroll = new ScrollState();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly filePath: string;
  private readonly close: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    filePath: string,
    content: string,
    close: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.filePath = filePath;
    this.close = close;
    this.markdown = new Markdown(content, 1, 0, getMarkdownTheme());
  }

  render(width: number): string[] {
    const viewerHeight = Math.max(3, this.tui.terminal.rows - RESERVED_APP_ROWS);
    const bodyHeight = Math.max(1, viewerHeight - VIEWER_FRAME_ROWS);
    const rendered = this.markdown.render(width);
    this.scroll.update(rendered.length, bodyHeight);

    const body = rendered.slice(this.scroll.start, this.scroll.end);
    while (body.length < bodyHeight) body.push("");

    const title = this.theme.bold(` Markdown: ${basename(this.filePath)}`);
    const path = this.theme.fg("dim", ` — ${this.filePath}`);
    const position =
      this.scroll.total === 0
        ? "0/0"
        : `${this.scroll.start + 1}-${this.scroll.end}/${this.scroll.total}`;
    const help = ` ${position}  ↑↓/jk scroll  PgUp/PgDn page  g/G ends  q/Esc close`;

    return [
      truncateToWidth(this.theme.fg("accent", title) + path, width),
      ...body,
      truncateToWidth(this.theme.fg("dim", help), width),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.close();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.scroll.move(-1);
    } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.scroll.move(1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scroll.movePage(-1);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scroll.movePage(1);
    } else if (matchesKey(data, Key.home) || matchesKey(data, "g")) {
      this.scroll.moveToStart();
    } else if (matchesKey(data, Key.end) || matchesKey(data, Key.shift("g"))) {
      this.scroll.moveToEnd();
    } else {
      return;
    }

    this.tui.requestRender();
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}
