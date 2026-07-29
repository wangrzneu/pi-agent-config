import { renderMermaidASCII } from "beautiful-mermaid";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import type { ResolvedDocumentSegment, WorkspaceDocument } from "./document-workspace.ts";

export interface RenderedDocumentLine {
  text: string;
  kind: "text" | "image" | "mermaid";
}

interface SegmentRenderer {
  render(width: number): RenderedDocumentLine[];
  invalidate(): void;
}

class MarkdownSegmentRenderer implements SegmentRenderer {
  private readonly component: Markdown;

  constructor(text: string) {
    this.component = new Markdown(text, 1, 0, getMarkdownTheme());
  }

  render(width: number): RenderedDocumentLine[] {
    return this.component.render(width).map((text) => ({ text, kind: "text" }));
  }

  invalidate(): void {
    this.component.invalidate();
  }
}

class ImageSegmentRenderer implements SegmentRenderer {
  private readonly component?: Image;

  constructor(
    private readonly segment: Extract<ResolvedDocumentSegment, { kind: "image" }>,
    theme: Theme,
  ) {
    if (segment.resource) {
      this.component = new Image(
        segment.resource.base64,
        segment.resource.mimeType,
        { fallbackColor: (text) => theme.fg("dim", text) },
        { filename: segment.resource.filename, maxWidthCells: 80, maxHeightCells: 28 },
      );
    }
  }

  render(width: number): RenderedDocumentLine[] {
    if (!this.component) {
      const label = this.segment.alt || this.segment.source;
      return [
        {
          text: ` 🖼 ${label} — ${this.segment.error ?? "Image unavailable."}`,
          kind: "text",
        },
      ];
    }

    const caption = this.segment.alt ? [{ text: ` ${this.segment.alt}`, kind: "text" as const }] : [];
    const imageKind = getCapabilities().images ? "image" as const : "text" as const;
    return [
      ...caption,
      ...this.component.render(width).map((text) => ({ text, kind: imageKind })),
      { text: "", kind: "text" },
    ];
  }

  invalidate(): void {
    this.component?.invalidate();
  }
}

class MermaidSegmentRenderer implements SegmentRenderer {
  private readonly output?: string[];
  private readonly error?: string;

  constructor(source: string, private readonly theme: Theme) {
    try {
      this.output = renderMermaidASCII(source, {
        colorMode: "none",
        paddingX: 3,
        paddingY: 2,
        boxBorderPadding: 1,
      }).split("\n");
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unknown Mermaid rendering error.";
    }
  }

  render(width: number): RenderedDocumentLine[] {
    if (this.error) {
      return [
        {
          text: truncateToWidth(this.theme.fg("error", ` Mermaid: ${this.error}`), width),
          kind: "text",
        },
      ];
    }

    return [
      { text: this.theme.fg("accent", this.theme.bold(" Mermaid")), kind: "mermaid" },
      ...(this.output ?? []).map((line) => ({
        text: truncateToWidth(` ${this.theme.fg("text", line)}`, width),
        kind: "mermaid" as const,
      })),
      { text: "", kind: "text" },
    ];
  }

  invalidate(): void {}
}

export class DocumentRenderer {
  private readonly segments: SegmentRenderer[];

  constructor(document: WorkspaceDocument, theme: Theme) {
    this.segments = document.segments.map((segment) => {
      if (segment.kind === "image") return new ImageSegmentRenderer(segment, theme);
      if (segment.kind === "mermaid") return new MermaidSegmentRenderer(segment.source, theme);
      return new MarkdownSegmentRenderer(segment.text);
    });
  }

  render(width: number): RenderedDocumentLine[] {
    return this.segments.flatMap((segment) => segment.render(width));
  }

  invalidate(): void {
    for (const segment of this.segments) segment.invalidate();
  }
}
