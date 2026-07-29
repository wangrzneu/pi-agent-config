import { basename, dirname } from "node:path";
import { type Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { DocumentRenderer, type RenderedDocumentLine } from "./document-renderer.ts";
import {
  DocumentWorkspace,
  type DirectoryEntry,
  type WorkspaceDocument,
} from "./document-workspace.ts";
import { SearchState } from "./search-state.ts";
import { ScrollState } from "./scroll-state.ts";

const RESERVED_APP_ROWS = 2;
const VIEWER_FRAME_ROWS = 2;
const ANSI_AND_OSC = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;

type ViewerMode = "document" | "search" | "directory" | "links";

function stripTerminalFormatting(value: string): string {
  return value.replace(ANSI_AND_OSC, "");
}

function decodeSearchCharacter(data: string): string | undefined {
  const kittyCharacter = decodeKittyPrintable(data);
  if (kittyCharacter) return kittyCharacter;
  const characters = [...data];
  if (characters.length !== 1 || /[\u0000-\u001f\u007f]/.test(data)) return undefined;
  return data;
}

export class MarkdownViewer implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly workspace: DocumentWorkspace;
  private readonly close: () => void;
  private readonly scroll = new ScrollState();
  private readonly search = new SearchState();

  private document: WorkspaceDocument;
  private renderer: DocumentRenderer;
  private mode: ViewerMode = "document";
  private status = "";
  private renderedLines: RenderedDocumentLine[] = [];
  private plainLines: string[] = [];
  private directoryPath = "";
  private directoryEntries: DirectoryEntry[] = [];
  private selectedIndex = 0;
  private stopWatching: () => void = () => {};
  private disposed = false;
  private loadGeneration = 0;
  private pendingAnchor?: string;

  constructor(
    tui: TUI,
    theme: Theme,
    workspace: DocumentWorkspace,
    document: WorkspaceDocument,
    close: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.workspace = workspace;
    this.document = document;
    this.close = close;
    this.renderer = new DocumentRenderer(document, theme);
    this.watchCurrentDocument();
  }

  render(width: number): string[] {
    const viewerHeight = Math.max(3, this.tui.terminal.rows - RESERVED_APP_ROWS);
    const bodyHeight = Math.max(1, viewerHeight - VIEWER_FRAME_ROWS);

    if (this.mode === "directory") return this.renderDirectory(width, bodyHeight);
    if (this.mode === "links") return this.renderLinks(width, bodyHeight);
    return this.renderDocument(width, bodyHeight);
  }

  handleInput(data: string): void {
    if (this.mode === "search") {
      this.handleSearchInput(data);
      return;
    }
    if (this.mode === "directory") {
      this.handleDirectoryInput(data);
      return;
    }
    if (this.mode === "links") {
      this.handleLinksInput(data);
      return;
    }
    this.handleDocumentInput(data);
  }

  invalidate(): void {
    this.renderer.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
  }

  private renderDocument(width: number, bodyHeight: number): string[] {
    this.renderedLines = this.renderer.render(width);
    this.plainLines = this.renderedLines.map((line) => stripTerminalFormatting(line.text));
    if (this.pendingAnchor) {
      const anchor = this.pendingAnchor;
      this.pendingAnchor = undefined;
      this.scrollToAnchor(anchor);
    }
    this.search.update(this.plainLines);
    this.scroll.update(this.renderedLines.length, bodyHeight);

    const matches = new Set(this.search.matchLines);
    const currentMatch = this.search.currentLine;
    const body = this.renderedLines
      .slice(this.scroll.start, this.scroll.end)
      .map((line, index) => {
        if (line.kind === "image") return line.text;
        const absoluteIndex = this.scroll.start + index;
        const highlighted =
          absoluteIndex === currentMatch
            ? this.theme.fg("accent", line.text)
            : matches.has(absoluteIndex)
              ? this.theme.fg("warning", line.text)
              : line.text;
        return this.paintBackground(
          highlighted,
          width,
          absoluteIndex === currentMatch ? "selectedBg" : "customMessageBg",
        );
      });

    while (body.length < bodyHeight) {
      body.push(this.paintBackground("", width, "customMessageBg"));
    }

    const position =
      this.scroll.total === 0
        ? "0/0"
        : `${this.scroll.start + 1}-${this.scroll.end}/${this.scroll.total}`;
    const searchInfo = this.search.query ? `  find:${this.search.query} ${this.search.position}` : "";
    const footer =
      this.mode === "search"
        ? ` /${this.search.draft}█  Enter search  Esc cancel`
        : ` ${position}${searchInfo}  / find  n/N next  d files  l links  r reload  q close`;

    return [
      this.paintBackground(
        this.theme.bold(` Markdown: ${basename(this.document.path)}`) +
          this.theme.fg("dim", ` — ${this.document.path}${this.status ? ` — ${this.status}` : ""}`),
        width,
        "selectedBg",
      ),
      ...body,
      this.paintBackground(this.theme.fg("dim", footer), width, "selectedBg"),
    ];
  }

  private renderDirectory(width: number, bodyHeight: number): string[] {
    const body = this.renderSelectionList(
      this.directoryEntries.map((entry) => {
        const icon = entry.kind === "markdown" ? "  " : "▸ ";
        return `${icon}${entry.name}`;
      }),
      width,
      bodyHeight,
    );

    return [
      this.paintBackground(
        this.theme.bold(" Markdown files") + this.theme.fg("dim", ` — ${this.directoryPath}`),
        width,
        "selectedBg",
      ),
      ...body,
      this.paintBackground(
        this.theme.fg("dim", " ↑↓/jk select  Enter open  ← parent  Esc back  q close"),
        width,
        "selectedBg",
      ),
    ];
  }

  private renderLinks(width: number, bodyHeight: number): string[] {
    const items = this.document.links.map(
      (link, index) => `${index + 1}. ${link.label} → ${link.target}`,
    );
    const body = this.renderSelectionList(
      items.length > 0 ? items : ["No links in this document."],
      width,
      bodyHeight,
    );

    return [
      this.paintBackground(
        this.theme.bold(" Document links") +
          this.theme.fg("dim", ` — ${basename(this.document.path)}`),
        width,
        "selectedBg",
      ),
      ...body,
      this.paintBackground(
        this.theme.fg("dim", " ↑↓/jk select  Enter open  Esc back  q close"),
        width,
        "selectedBg",
      ),
    ];
  }

  private renderSelectionList(items: string[], width: number, bodyHeight: number): string[] {
    const maxStart = Math.max(0, items.length - bodyHeight);
    const start = Math.max(0, Math.min(this.selectedIndex - bodyHeight + 1, maxStart));
    const body = items.slice(start, start + bodyHeight).map((item, index) => {
      const selected = start + index === this.selectedIndex;
      const line = `${selected ? "›" : " "} ${item}`;
      return this.paintBackground(
        selected ? this.theme.fg("accent", this.theme.bold(line)) : line,
        width,
        selected ? "selectedBg" : "customMessageBg",
      );
    });
    while (body.length < bodyHeight) {
      body.push(this.paintBackground("", width, "customMessageBg"));
    }
    return body;
  }

  private handleDocumentInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.close();
      return;
    }

    if (matchesKey(data, "/")) {
      this.search.begin();
      this.mode = "search";
    } else if (matchesKey(data, "n")) {
      this.moveSearch(1);
    } else if (matchesKey(data, Key.shift("n"))) {
      this.moveSearch(-1);
    } else if (matchesKey(data, "d")) {
      void this.showDirectory(dirname(this.document.path));
    } else if (matchesKey(data, "l") || matchesKey(data, "o")) {
      this.mode = "links";
      this.selectedIndex = 0;
    } else if (matchesKey(data, "r")) {
      void this.reloadDocument("Reloaded");
    } else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
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

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.search.cancel();
      this.mode = "document";
    } else if (matchesKey(data, Key.enter)) {
      this.search.commit();
      this.mode = "document";
      this.search.update(this.plainLines);
      this.moveSearch(1);
    } else if (matchesKey(data, Key.backspace)) {
      this.search.setDraft(this.search.draft.slice(0, -1));
    } else {
      const printable = decodeSearchCharacter(data);
      if (!printable || printable.length !== 1) return;
      this.search.setDraft(this.search.draft + printable);
    }
    this.tui.requestRender();
  }

  private handleDirectoryInput(data: string): void {
    if (matchesKey(data, "q")) {
      this.close();
    } else if (matchesKey(data, Key.escape)) {
      this.mode = "document";
      this.tui.requestRender();
    } else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.moveSelection(-1, this.directoryEntries.length);
    } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.moveSelection(1, this.directoryEntries.length);
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) {
      void this.showDirectory(dirname(this.directoryPath));
    } else if (matchesKey(data, Key.enter)) {
      const entry = this.directoryEntries[this.selectedIndex];
      if (!entry) return;
      if (entry.kind === "markdown") void this.openDocument(entry.path);
      else void this.showDirectory(entry.path);
    }
  }

  private handleLinksInput(data: string): void {
    if (matchesKey(data, "q")) {
      this.close();
    } else if (matchesKey(data, Key.escape)) {
      this.mode = "document";
      this.tui.requestRender();
    } else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.moveSelection(-1, this.document.links.length);
    } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.moveSelection(1, this.document.links.length);
    } else if (matchesKey(data, Key.enter)) {
      const link = this.document.links[this.selectedIndex];
      if (link) void this.openLink(link.target);
    }
  }

  private moveSelection(delta: number, count: number): void {
    if (count === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + delta, count - 1));
    this.tui.requestRender();
  }

  private moveSearch(direction: 1 | -1): void {
    this.search.update(this.plainLines);
    const line = this.search.move(direction);
    if (line === undefined) {
      this.status = this.search.query ? `No matches for “${this.search.query}”` : "Enter a search term";
    } else {
      this.status = "";
      this.scroll.moveTo(line);
    }
  }

  private async showDirectory(path: string): Promise<void> {
    try {
      this.directoryEntries = await this.workspace.listDirectory(path);
      this.directoryPath = path;
      this.selectedIndex = 0;
      this.mode = "directory";
      this.status = "";
    } catch (error) {
      this.status = error instanceof Error ? error.message : "Unable to read directory.";
    }
    this.tui.requestRender();
  }

  private async openDocument(path: string): Promise<void> {
    const generation = ++this.loadGeneration;
    this.status = `Loading ${basename(path)}…`;
    this.tui.requestRender();
    try {
      const document = await this.workspace.open(path, dirname(this.document.path));
      if (this.disposed || generation !== this.loadGeneration) return;
      this.setDocument(document);
      this.mode = "document";
      this.scroll.moveToStart();
      this.status = "";
    } catch (error) {
      this.status = error instanceof Error ? error.message : "Unable to open document.";
    }
    this.tui.requestRender();
  }

  private async reloadDocument(message: string): Promise<void> {
    const generation = ++this.loadGeneration;
    const previousOffset = this.scroll.start;
    try {
      const document = await this.workspace.open(this.document.path, dirname(this.document.path));
      if (this.disposed || generation !== this.loadGeneration) return;
      this.setDocument(document);
      this.scroll.moveTo(previousOffset);
      this.status = message;
    } catch (error) {
      this.status = error instanceof Error ? error.message : "Unable to reload document.";
    }
    this.tui.requestRender();
  }

  private async openLink(target: string): Promise<void> {
    try {
      const resolved = await this.workspace.resolveLink(this.document.path, target);
      if (resolved.kind === "anchor") {
        this.mode = "document";
        this.scrollToAnchor(resolved.value);
      } else if (resolved.kind === "document") {
        await this.openDocument(resolved.path);
        this.pendingAnchor = resolved.anchor;
      } else if (resolved.kind === "directory") {
        await this.showDirectory(resolved.path);
      } else {
        this.workspace.openExternal(resolved.target);
        this.mode = "document";
        this.status = `Opened ${resolved.target}`;
      }
    } catch (error) {
      this.mode = "document";
      this.status = error instanceof Error ? error.message : "Unable to open link.";
    }
    this.tui.requestRender();
  }

  private scrollToAnchor(anchor: string): void {
    const expected = decodeURIComponent(anchor).toLocaleLowerCase();
    const line = this.plainLines.findIndex((value) => {
      const slug = value
        .trim()
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-");
      return slug === expected;
    });
    if (line >= 0) {
      this.scroll.moveTo(line);
      this.status = "";
    } else {
      this.status = `Anchor not found: #${anchor}`;
    }
  }

  private setDocument(document: WorkspaceDocument): void {
    this.stopWatching();
    this.document = document;
    this.renderer = new DocumentRenderer(document, this.theme);
    this.search.setDraft("");
    this.search.commit();
    this.watchCurrentDocument();
  }

  private watchCurrentDocument(): void {
    this.stopWatching = this.workspace.watchDocument(this.document.path, () => {
      if (!this.disposed) void this.reloadDocument("Updated on disk");
    });
  }

  private paintBackground(
    line: string,
    width: number,
    background: "customMessageBg" | "selectedBg",
  ): string {
    const backgroundAnsi = this.theme.getBgAnsi(background);
    const clipped = truncateToWidth(line, width, "");
    const padded = clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    const reapplied = padded.replace(/\x1b\[0m/g, `\x1b[0m${backgroundAnsi}`);
    return `${backgroundAnsi}${reapplied}\x1b[0m`;
  }
}
