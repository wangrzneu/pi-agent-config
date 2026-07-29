export interface MarkdownSegment {
  kind: "markdown";
  text: string;
}

export interface ImageSegment {
  kind: "image";
  source: string;
  alt: string;
}

export interface MermaidSegment {
  kind: "mermaid";
  source: string;
}

export type DocumentSegment = MarkdownSegment | ImageSegment | MermaidSegment;

export interface DocumentLink {
  label: string;
  target: string;
}

export interface ParsedMarkdownDocument {
  segments: DocumentSegment[];
  links: DocumentLink[];
}

const INLINE_IMAGE =
  /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
const INLINE_LINK =
  /(?<!!)\[([^\]]+)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
const AUTO_LINK = /<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/g;

function collectLinks(markdown: string, links: DocumentLink[]): void {
  for (const match of markdown.matchAll(INLINE_LINK)) {
    links.push({ label: match[1].trim(), target: (match[2] ?? match[3]).trim() });
  }
  for (const match of markdown.matchAll(AUTO_LINK)) {
    links.push({ label: match[1], target: match[1] });
  }
}

export function parseMarkdownDocument(content: string): ParsedMarkdownDocument {
  const lines = content.split(/\r?\n/);
  const segments: DocumentSegment[] = [];
  const links: DocumentLink[] = [];
  let markdownBuffer: string[] = [];

  const flushMarkdown = () => {
    if (markdownBuffer.length === 0) return;
    const text = markdownBuffer.join("\n");
    segments.push({ kind: "markdown", text });
    markdownBuffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/);

    if (fence) {
      const marker = fence[1];
      const language = (fence[2] ?? "").toLowerCase();
      const fencedLines = [line];
      const body: string[] = [];

      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(candidate)) {
          fencedLines.push(candidate);
          break;
        }
        fencedLines.push(candidate);
        body.push(candidate);
        index += 1;
      }

      if (language === "mermaid") {
        flushMarkdown();
        segments.push({ kind: "mermaid", source: body.join("\n").trim() });
      } else {
        markdownBuffer.push(...fencedLines);
      }
      continue;
    }

    const images = [...line.matchAll(INLINE_IMAGE)];
    if (images.length > 0) {
      let cursor = 0;
      for (const image of images) {
        const before = line.slice(cursor, image.index);
        if (before.trim()) {
          markdownBuffer.push(before);
          collectLinks(before, links);
        }
        flushMarkdown();
        segments.push({
          kind: "image",
          alt: image[1].trim(),
          source: (image[2] ?? image[3]).trim(),
        });
        cursor = image.index + image[0].length;
      }
      const after = line.slice(cursor);
      if (after.trim()) {
        markdownBuffer.push(after);
        collectLinks(after, links);
      }
      continue;
    }

    markdownBuffer.push(line);
    collectLinks(line, links);
  }

  flushMarkdown();
  return { segments, links };
}
