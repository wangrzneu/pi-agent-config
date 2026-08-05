import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SANDBOX_TEMP_ROOT = join(
  tmpdir(),
  `pi-sandbox-${process.pid}-${randomUUID()}`,
);

export async function ensureSandboxTempRoot(): Promise<void> {
  await mkdir(join(SANDBOX_TEMP_ROOT, "tmp"), { recursive: true, mode: 0o700 });
}
