import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_STATE_BYTES = 64 * 1024;
const MAX_CONTEXTS = 64;

export class KubernetesContextSelectionStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async pathForProject(workspace: string): Promise<string> {
    const canonicalWorkspace = await realpath(workspace);
    const key = createHash("sha256").update(canonicalWorkspace).digest("hex");
    return join(this.root, `${key}.json`);
  }

  async load(workspace: string): Promise<string[]> {
    const path = await this.pathForProject(workspace);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STATE_BYTES) {
        throw new Error("Invalid persisted Kubernetes context selection state");
      }
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        !isRecord(parsed)
        || Object.keys(parsed).some((key) => key !== "contexts")
        || !Array.isArray(parsed.contexts)
        || parsed.contexts.length > MAX_CONTEXTS
      ) {
        throw new Error("Invalid persisted Kubernetes context selection state");
      }
      const contexts = parsed.contexts;
      for (const context of contexts) validateContextName(context);
      return [...new Set(contexts)].sort();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      if (error instanceof SyntaxError) {
        throw new Error("Invalid persisted Kubernetes context selection state");
      }
      throw error;
    }
  }

  async save(workspace: string, contexts: string[]): Promise<void> {
    if (contexts.length > MAX_CONTEXTS) throw new Error("Too many persisted Kubernetes context selections");
    for (const context of contexts) validateContextName(context);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootMetadata = await lstat(this.root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("Kubernetes context selection root is not a real directory");
    }
    const path = await this.pathForProject(workspace);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ contexts: [...new Set(contexts)].sort() })}\n`;
    if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("Kubernetes context selection state is too large");
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async clear(workspace: string): Promise<void> {
    await rm(await this.pathForProject(workspace), { force: true });
  }
}

function validateContextName(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value === ""
    || value.length > 512
    || /[\0-\x1f\x7f]/.test(value)
  ) {
    throw new Error("Invalid Kubernetes context name in persisted selection");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
