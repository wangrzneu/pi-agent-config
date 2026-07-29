import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ImageResource {
  base64: string;
  mimeType: string;
  filename: string;
}

export class ImageLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageLoadError";
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function supportedMimeType(value: string | null, path: string): string | undefined {
  const contentType = value?.split(";", 1)[0].trim().toLowerCase();
  if (contentType && Object.values(MIME_BY_EXTENSION).includes(contentType)) return contentType;
  return MIME_BY_EXTENSION[extname(path.split(/[?#]/, 1)[0]).toLowerCase()];
}

function assertSize(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new ImageLoadError(`Image is too large (${size} bytes; limit ${maxBytes} bytes).`);
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize)) assertSize(declaredSize, maxBytes);
  if (!response.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    assertSize(total, maxBytes);
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function loadRemoteImage(source: string, maxBytes: number): Promise<ImageResource> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(source, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new ImageLoadError(`Image request failed with HTTP ${response.status}.`);

    const mimeType = supportedMimeType(response.headers.get("content-type"), source);
    if (!mimeType) throw new ImageLoadError("Only PNG, JPEG, GIF, and WebP images are supported.");

    const bytes = await readResponseBytes(response, maxBytes);
    return {
      base64: Buffer.from(bytes).toString("base64"),
      mimeType,
      filename: basename(new URL(source).pathname) || "remote-image",
    };
  } catch (error) {
    if (error instanceof ImageLoadError) throw error;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Image request timed out."
        : "Unable to download image.";
    throw new ImageLoadError(message, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function loadDataImage(source: string, maxBytes: number): ImageResource {
  const match = source.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw new ImageLoadError("Unsupported image data URL.");
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  assertSize(bytes.byteLength, maxBytes);
  return { base64: bytes.toString("base64"), mimeType: match[1].toLowerCase(), filename: "inline-image" };
}

export function resolveLocalImagePath(source: string, documentPath: string): string {
  if (source.startsWith("file:")) return fileURLToPath(source);
  const decoded = decodeURIComponent(source.split(/[?#]/, 1)[0]);
  return resolve(dirname(documentPath), decoded);
}

export async function loadImageResource(
  source: string,
  documentPath: string,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<ImageResource> {
  if (source.startsWith("data:")) return loadDataImage(source, maxBytes);
  if (/^https?:\/\//i.test(source)) return loadRemoteImage(source, maxBytes);

  const path = resolveLocalImagePath(source, documentPath);
  const mimeType = supportedMimeType(null, path);
  if (!mimeType) throw new ImageLoadError("Only PNG, JPEG, GIF, and WebP images are supported.");

  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (error) {
    throw new ImageLoadError(`Image not found: ${path}`, { cause: error });
  }
  if (!fileStat.isFile()) throw new ImageLoadError(`Image path is not a file: ${path}`);
  assertSize(fileStat.size, maxBytes);

  const bytes = await readFile(path);
  assertSize(bytes.byteLength, maxBytes);
  return { base64: bytes.toString("base64"), mimeType, filename: basename(path) };
}
