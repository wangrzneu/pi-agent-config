#!/usr/bin/env node
/**
 * Analyze A/B results produced by `bench/run.mjs`.
 *
 * Usage:
 *   node bench/analyze.mjs --runs bench/results/<run-id>
 *   node bench/analyze.mjs --runs bench/results/<run-id>/runs.jsonl --out report.md
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonl, renderReport } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

async function resolveRunsPath(root) {
  const info = await stat(root).catch(() => undefined);
  if (!info) throw new Error(`Results not found: ${root}`);
  if (info.isFile()) return root;

  const direct = join(root, "runs.jsonl");
  const directInfo = await stat(direct).catch(() => undefined);
  if (directInfo?.isFile()) return direct;

  const entries = await readdir(root, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, "runs.jsonl");
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile()) candidates.push({ path: candidate, mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates[0]) return candidates[0].path;
  throw new Error(`No runs.jsonl found under ${root}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runsPath = await resolveRunsPath(
    resolve(args.runs ?? join(HERE, "results")),
  );
  const { events: runs, malformed } = parseJsonl(await readFile(runsPath, "utf8"));
  if (runs.length === 0) throw new Error(`No runs in ${runsPath}`);

  const report = renderReport(runs, { seed: Number(args.seed ?? 1) });
  if (args.out) {
    await writeFile(resolve(args.out), report);
    console.log(`wrote ${resolve(args.out)}`);
  } else {
    process.stdout.write(report);
  }
  if (malformed.length > 0) {
    console.error(`warning: ${malformed.length} malformed result line(s) ignored`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
