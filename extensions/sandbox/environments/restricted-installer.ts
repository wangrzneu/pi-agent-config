import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { RuntimeInstallerOptions } from "./installer.ts";

const execFileAsync = promisify(execFile);
const EXTRACTOR = fileURLToPath(new URL("./archive-extractor.mjs", import.meta.url));

interface InstallerSandboxRuntime {
  wrapWithSandbox(
    command: string,
    shell: string,
    config?: Partial<SandboxRuntimeConfig>,
  ): Promise<string>;
  cleanupAfterCommand(): void;
}

export function createRestrictedArchiveExtractor(
  runtime: InstallerSandboxRuntime,
): NonNullable<RuntimeInstallerOptions["archiveExtractor"]> {
  return async ({ archivePath, destination, stripComponents }) => {
    const [canonicalArchivePath, canonicalDestination] = await Promise.all([
      realpath(archivePath),
      realpath(destination),
    ]);
    const command = [
      process.execPath,
      EXTRACTOR,
      canonicalArchivePath,
      canonicalDestination,
      String(stripComponents),
    ].map(shellQuote).join(" ");
    const wrapped = await runtime.wrapWithSandbox(command, "/bin/bash", {
      network: { allowedDomains: [], deniedDomains: ["*"] },
      filesystem: {
        allowRead: [
          canonicalArchivePath,
          canonicalDestination,
          EXTRACTOR,
          dirname(process.execPath),
          process.cwd(),
          "/usr",
          "/bin",
          "/sbin",
          "/System",
          "/Library",
          "/opt/homebrew",
        ],
        denyWrite: [process.cwd()],
        allowWrite: [canonicalDestination],
      },
    });
    try {
      await execFileAsync("/bin/bash", ["-c", wrapped], {
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: canonicalDestination,
          TMPDIR: canonicalDestination,
        },
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
    } finally {
      runtime.cleanupAfterCommand();
    }
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
