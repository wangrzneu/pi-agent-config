import { spawn } from "node:child_process";
import { readdir, stat, unwatchFile, watchFile } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdownDocument, type DocumentLink, type DocumentSegment } from "./document-model.ts";
import { ImageLoadError, loadImageResource, type ImageResource } from "./image-loader.ts";
import { loadMarkdownFile } from "./markdown-loader.ts";

const MAX_RENDERED_IMAGES = 32;

export interface ResolvedImageSegment {
  kind: "image";
  source: string;
  alt: string;
  resource?: ImageResource;
  error?: string;
}

export type ResolvedDocumentSegment =
  | Exclude<DocumentSegment, { kind: "image" }>
  | ResolvedImageSegment;

export interface WorkspaceDocument {
  path: string;
  content: string;
  segments: ResolvedDocumentSegment[];
  links: DocumentLink[];
}

export interface DirectoryEntry {
  kind: "parent" | "directory" | "markdown";
  name: string;
  path: string;
}

export type LinkTarget =
  | { kind: "anchor"; value: string }
  | { kind: "document"; path: string; anchor?: string }
  | { kind: "directory"; path: string }
  | { kind: "external"; target: string };

export class DocumentWorkspace {
  async open(argument: string, cwd: string): Promise<WorkspaceDocument> {
    const file = await loadMarkdownFile(argument, cwd);
    const parsed = parseMarkdownDocument(file.content);
    let imageCount = 0;
    const segments = await Promise.all(
      parsed.segments.map(async (segment): Promise<ResolvedDocumentSegment> => {
        if (segment.kind !== "image") return segment;
        imageCount += 1;
        if (imageCount > MAX_RENDERED_IMAGES) {
          return { ...segment, error: `Image limit exceeded (${MAX_RENDERED_IMAGES} per document).` };
        }
        try {
          const resource = await loadImageResource(segment.source, file.path);
          return { ...segment, resource };
        } catch (error) {
          const message =
            error instanceof ImageLoadError ? error.message : "Unable to render image.";
          return { ...segment, error: message };
        }
      }),
    );
    return { path: file.path, content: file.content, segments, links: parsed.links };
  }

  async listDirectory(path: string): Promise<DirectoryEntry[]> {
    const directory = resolve(path);
    const entries = await new Promise<import("node:fs").Dirent[]>((resolveEntries, reject) => {
      readdir(directory, { withFileTypes: true }, (error, result) => {
        if (error) reject(error);
        else resolveEntries(result);
      });
    });

    const visible = entries
      .filter(
        (entry) =>
          (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name)) ||
          [".md", ".markdown"].includes(extname(entry.name).toLowerCase()),
      )
      .map((entry): DirectoryEntry => ({
        kind: entry.isDirectory() ? "directory" : "markdown",
        name: entry.name,
        path: join(directory, entry.name),
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parent = dirname(directory);
    if (parent !== directory) {
      visible.unshift({ kind: "parent", name: "..", path: parent });
    }
    return visible;
  }

  async resolveLink(documentPath: string, target: string): Promise<LinkTarget> {
    if (target.startsWith("#")) return { kind: "anchor", value: target.slice(1) };
    if (/^(https?:|mailto:)/i.test(target)) return { kind: "external", target };

    const hashIndex = target.indexOf("#");
    const anchor = hashIndex >= 0 ? target.slice(hashIndex + 1) : undefined;
    let path: string;
    if (target.startsWith("file:")) {
      path = fileURLToPath(hashIndex >= 0 ? target.slice(0, hashIndex) : target);
    } else {
      const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
      path = resolve(dirname(documentPath), decodeURIComponent(withoutFragment));
    }

    try {
      const targetStat = await new Promise<import("node:fs").Stats>((resolveStat, reject) => {
        stat(path, (error, result) => {
          if (error) reject(error);
          else resolveStat(result);
        });
      });
      if (targetStat.isDirectory()) return { kind: "directory", path };
    } catch {
      // Let the platform opener report missing non-Markdown targets.
    }

    if ([".md", ".markdown"].includes(extname(path).toLowerCase())) {
      return { kind: "document", path, anchor };
    }
    return { kind: "external", target: path };
  }

  watchDocument(path: string, onChange: () => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    const listener = (current: import("node:fs").Stats, previous: import("node:fs").Stats) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size &&
        current.ino === previous.ino
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 120);
    };
    watchFile(path, { persistent: false, interval: 500 }, listener);

    return () => {
      if (timer) clearTimeout(timer);
      unwatchFile(path, listener);
    };
  }

  openExternal(target: string): void {
    let command: string;
    let args: string[];

    if (process.platform === "darwin") {
      command = "open";
      args = [target];
    } else if (process.platform === "win32") {
      command = "rundll32";
      args = ["url.dll,FileProtocolHandler", target];
    } else {
      command = "xdg-open";
      args = [target];
    }

    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
}
