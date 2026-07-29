import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export type MarkdownFileErrorCode =
  | "empty-path"
  | "remote-url"
  | "not-found"
  | "not-a-file"
  | "unsupported-extension"
  | "too-large"
  | "invalid-encoding"
  | "read-failed";

export class MarkdownFileError extends Error {
  readonly code: MarkdownFileErrorCode;

  constructor(
    code: MarkdownFileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MarkdownFileError";
    this.code = code;
  }
}

export interface LoadedMarkdownFile {
  path: string;
  content: string;
  size: number;
}

function unwrapMatchingQuotes(value: string): string {
  const first = value.at(0);
  const last = value.at(-1);
  if (value.length >= 2 && first === last && (first === '"' || first === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function resolveMarkdownPath(argument: string, cwd: string): string {
  const input = unwrapMatchingQuotes(argument.trim());
  if (!input) {
    throw new MarkdownFileError("empty-path", "Usage: /md <path-to-markdown-file>");
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    throw new MarkdownFileError("remote-url", "Only local Markdown files can be opened.");
  }

  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return resolve(cwd, input);
}

export async function loadMarkdownFile(
  argument: string,
  cwd: string,
  maxBytes = MAX_MARKDOWN_BYTES,
): Promise<LoadedMarkdownFile> {
  const path = resolveMarkdownPath(argument, cwd);

  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MarkdownFileError("not-found", `Markdown file not found: ${path}`, { cause: error });
    }
    throw new MarkdownFileError("read-failed", `Cannot inspect Markdown file: ${path}`, { cause: error });
  }

  if (!fileStat.isFile()) {
    throw new MarkdownFileError("not-a-file", `Path is not a regular file: ${path}`);
  }

  if (![".md", ".markdown"].includes(extname(path).toLowerCase())) {
    throw new MarkdownFileError(
      "unsupported-extension",
      "Only .md and .markdown files can be opened.",
    );
  }

  if (fileStat.size > maxBytes) {
    throw new MarkdownFileError(
      "too-large",
      `Markdown file is too large (${fileStat.size} bytes; limit ${maxBytes} bytes).`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new MarkdownFileError("read-failed", `Cannot read Markdown file: ${path}`, { cause: error });
  }

  if (bytes.byteLength > maxBytes) {
    throw new MarkdownFileError(
      "too-large",
      `Markdown file is too large (${bytes.byteLength} bytes; limit ${maxBytes} bytes).`,
    );
  }

  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    return { path, content, size: bytes.byteLength };
  } catch (error) {
    throw new MarkdownFileError("invalid-encoding", "Markdown file must be valid UTF-8.", {
      cause: error,
    });
  }
}
