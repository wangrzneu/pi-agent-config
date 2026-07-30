import {
  copyToClipboard,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { ScrollState } from "../markdown-viewer/scroll-state.ts";

const RESERVED_APP_ROWS = 2;
const FRAME_ROWS = 2;
const ANSI_RESET = /\x1b\[0m/g;

export interface BtwExchange {
  question: string;
  answer: string;
}

export class BtwViewer implements Component {
  private readonly scroll = new ScrollState();
  private readonly markdown: Markdown;
  private selectedIndex: number;
  private renderedLines: string[] = [];
  private status = "";

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly exchanges: BtwExchange[],
    initialIndex: number,
    private readonly close: () => void,
    private readonly clearHistory: () => void,
  ) {
    this.selectedIndex = Math.max(
      0,
      Math.min(initialIndex, exchanges.length - 1),
    );
    this.markdown = new Markdown(
      this.current.answer,
      1,
      0,
      getMarkdownTheme(),
    );
  }

  render(width: number): string[] {
    const viewerHeight = Math.max(
      4,
      this.tui.terminal.rows - RESERVED_APP_ROWS,
    );
    const bodyHeight = Math.max(1, viewerHeight - FRAME_ROWS);
    this.renderedLines = this.markdown.render(Math.max(1, width));
    this.scroll.update(this.renderedLines.length, bodyHeight);

    const body = this.renderedLines
      .slice(this.scroll.start, this.scroll.end)
      .map((line) => this.paintBackground(line, width, "customMessageBg"));
    while (body.length < bodyHeight) {
      body.push(this.paintBackground("", width, "customMessageBg"));
    }

    const position =
      this.scroll.total === 0
        ? "0/0"
        : `${this.scroll.start + 1}-${this.scroll.end}/${this.scroll.total}`;
    const history = `${this.selectedIndex + 1}/${this.exchanges.length}`;
    const question = truncateToWidth(
      sanitizeInline(this.current.question),
      Math.max(10, width - 22),
      "…",
    );
    const footer = ` ${position}  ↑↓/jk scroll  ←→ history  c copy  x clear  q close${this.status ? `  · ${this.status}` : ""}`;

    return [
      this.paintBackground(
        this.theme.bold(" BTW") +
          this.theme.fg("dim", ` · ${history} · ${question}`),
        width,
        "selectedBg",
      ),
      ...body,
      this.paintBackground(
        this.theme.fg("dim", footer),
        width,
        "selectedBg",
      ),
    ];
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, "q") ||
      data === " "
    ) {
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
    } else if (matchesKey(data, Key.left)) {
      this.selectExchange(this.selectedIndex - 1);
    } else if (matchesKey(data, Key.right)) {
      this.selectExchange(this.selectedIndex + 1);
    } else if (matchesKey(data, "c")) {
      void this.copyAnswer();
    } else if (matchesKey(data, "x")) {
      this.close();
      this.clearHistory();
      return;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  private get current(): BtwExchange {
    return this.exchanges[this.selectedIndex];
  }

  private selectExchange(index: number): void {
    const selected = Math.max(0, Math.min(index, this.exchanges.length - 1));
    if (selected === this.selectedIndex) return;
    this.selectedIndex = selected;
    this.markdown.setText(this.current.answer);
    this.scroll.moveToStart();
    this.status = "";
  }

  private async copyAnswer(): Promise<void> {
    try {
      await copyToClipboard(this.current.answer);
      this.status = "Copied";
    } catch {
      this.status = "Copy failed";
    }
    this.tui.requestRender();
  }

  private paintBackground(
    line: string,
    width: number,
    background: "customMessageBg" | "selectedBg",
  ): string {
    const backgroundAnsi = this.theme.getBgAnsi(background);
    const clipped = truncateToWidth(line, width, "");
    const padded =
      clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    const reapplied = padded.replace(
      ANSI_RESET,
      `\x1b[0m${backgroundAnsi}`,
    );
    return `${backgroundAnsi}${reapplied}\x1b[0m`;
  }
}

function sanitizeInline(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
