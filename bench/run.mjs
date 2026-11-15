#!/usr/bin/env node
/**
 * Paired A/B runner for Pi.
 *
 * For every task and repetition it runs the same prompt twice:
 *   off: PI_SYSTEM_ONE_ENABLED=0
 *   on:  PI_SYSTEM_ONE_ENABLED=1
 *
 * Each run gets a fresh clone, `--no-session`, the same model/tools/prompt, and
 * a JSON event capture plus the task's test command. Results are written as
 * `runs.jsonl` under the output directory.
 *
 * Usage:
 *   pi --version
 *   node bench/run.mjs \
 *     --tasks bench/tasks.example.json \
 *     --model anthropic/claude-sonnet-4-5:high \
 *     --reps 3 \
 *     --out bench/results
 *
 * The task commands are trusted shell commands. Run this harness only on
 * repositories and task files you trust.
 */

import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseJsonl,
  summarizeDiff,
  summarizeEvents,
  summarizeTrace,
} from "./lib.mjs";

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

function safeName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "run";
}

function fileKey(value) {
  return `${safeName(value)}-${hash(value).toString(16).slice(0, 8)}`;
}

function tail(text, limit = 2_000) {
  return text.length <= limit ? text : text.slice(-limit);
}

/** Run a command with bounded output and SIGTERM→SIGKILL cancellation. */
function runProcess(command, args, {
  cwd,
  env = process.env,
  timeoutSec = 0,
} = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolvePromise({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: 0,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        ...result,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    };

    const terminate = () => {
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        // The process may already be gone.
      }
      killTimer = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          // Ignore a second failure.
        }
      }, 5_000);
    };

    const timer = timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeoutSec * 1_000)
      : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal, error: undefined });
    });
  });
}

function shellCommand(command, cwd, env, timeoutSec) {
  if (!command) {
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });
  }
  const shell = process.platform === "win32"
    ? "cmd.exe"
    : (process.env.SHELL || "bash");
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", command]
    : ["-lc", command];
  return runProcess(shell, args, { cwd, env, timeoutSec });
}

function git(args, cwd, timeoutSec = 900) {
  return runProcess("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeoutSec,
  });
}

function shuffledConditions(seed, taskId, rep) {
  let state = (Number(seed) + rep * 7919 + hash(taskId)) >>> 0;
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state % 2 === 0 ? ["off", "on"] : ["on", "off"];
}

function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) {
    result ^= char.codePointAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function isRemoteRepo(repo) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || /^[^/]+@[^:]+:/.test(repo);
}

async function readTasks(path) {
  const baseDir = dirname(path);
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`No tasks found in ${path}`);
  }
  return tasks.map((task, index) => {
    if (!task || typeof task !== "object") {
      throw new Error(`Task ${index} is not an object`);
    }
    for (const field of ["id", "repo", "prompt"]) {
      if (typeof task[field] !== "string" || !task[field].trim()) {
        throw new Error(`Task ${index} is missing a non-empty "${field}"`);
      }
    }
    return {
      id: task.id,
      repo: isRemoteRepo(task.repo) || isAbsolute(task.repo)
        ? task.repo
        : resolve(baseDir, task.repo),
      commit: task.commit || "HEAD",
      workdir: task.workdir,
      setup: task.setup,
      prompt: task.prompt,
      test: task.test,
      timeoutSec: Number(task.timeoutSec) > 0 ? Number(task.timeoutSec) : 900,
      setupTimeoutSec: Number(task.setupTimeoutSec) > 0
        ? Number(task.setupTimeoutSec)
        : 1_800,
      testTimeoutSec: Number(task.testTimeoutSec) > 0
        ? Number(task.testTimeoutSec)
        : 900,
      category: typeof task.category === "string" ? task.category : undefined,
      difficulty: typeof task.difficulty === "string" ? task.difficulty : undefined,
      env: task.env && typeof task.env === "object" ? task.env : {},
    };
  });
}

async function runOne({
  task,
  condition,
  rep,
  runId,
  outDir,
  model,
  tools,
  extension,
  piCommand,
  keep,
}) {
  const started = Date.now();
  const workRoot = await mkdtemp(join(tmpdir(), "pi-ab-"));
  const repoDir = join(workRoot, "repo");
  const result = {
    runId,
    task: task.id,
    category: task.category,
    difficulty: task.difficulty,
    condition,
    rep,
    startedAt: new Date().toISOString(),
    success: false,
    error: undefined,
    setupExit: null,
    setupTimedOut: false,
    setupStderrTail: "",
    piExit: null,
    piSignal: null,
    piTimedOut: false,
    piMs: null,
    testExit: null,
    testTimedOut: false,
    testStderrTail: "",
    wallMs: null,
    summary: null,
    trace: null,
    diff: null,
    malformedEvents: 0,
    stderrTail: "",
  };

  try {
    const clone = await git(["clone", "--quiet", task.repo, repoDir], workRoot, 1_800);
    if (clone.exitCode !== 0) {
      result.error = `git clone failed: ${tail(clone.stderr)}`;
      result.wallMs = Date.now() - started;
      return result;
    }

    const checkout = await git(["checkout", "--quiet", task.commit], repoDir);
    if (checkout.exitCode !== 0) {
      result.error = `git checkout failed: ${tail(checkout.stderr)}`;
      result.wallMs = Date.now() - started;
      return result;
    }

    const cwd = task.workdir ? join(repoDir, task.workdir) : repoDir;
    const tracePath = join(
      outDir,
      `${fileKey(task.id)}-${condition}-${rep}.trace.jsonl`,
    );
    const env = {
      ...process.env,
      ...task.env,
      PI_WORK_STATUS_CLASSIFIER: "0",
      PI_SYSTEM_ONE_ENABLED: condition === "on" ? "1" : "0",
      PI_SYSTEM_ONE_TRACE: condition === "on" ? tracePath : "",
      ...(isAbsolute(task.repo) ? { PI_AB_SOURCE_REPO: task.repo } : {}),
    };

    const setup = await shellCommand(
      task.setup,
      cwd,
      env,
      task.setupTimeoutSec,
    );
    result.setupExit = setup.exitCode;
    result.setupTimedOut = setup.timedOut;
    result.setupStderrTail = tail(setup.stderr);
    if (setup.exitCode !== 0 || setup.timedOut) {
      result.error = `setup failed: ${tail(setup.stderr || setup.stdout)}`;
      result.wallMs = Date.now() - started;
      return result;
    }

    const piArgs = [
      "--mode",
      "json",
      "--no-session",
      "--model",
      model,
      "--tools",
      tools,
      "-ne",
      "-e",
      extension,
      "--",
      task.prompt,
    ];
    const pi = await runProcess(piCommand, piArgs, {
      cwd,
      env,
      timeoutSec: task.timeoutSec,
    });
    result.piExit = pi.exitCode;
    result.piSignal = pi.signal;
    result.piTimedOut = pi.timedOut;
    result.piMs = pi.durationMs;
    result.stderrTail = tail(pi.stderr);

    const { events, malformed } = parseJsonl(pi.stdout);
    result.malformedEvents = malformed.length;
    result.summary = summarizeEvents(events);

    const test = await shellCommand(
      task.test,
      cwd,
      env,
      task.testTimeoutSec,
    );
    result.testExit = test.exitCode;
    result.testTimedOut = test.timedOut;
    result.testStderrTail = tail(test.stderr);
    result.success = task.test
      ? test.exitCode === 0 && !test.timedOut
      : pi.exitCode === 0 && !pi.timedOut;

    const diff = await git(["diff", "--numstat"], repoDir, 60);
    result.diff = summarizeDiff(diff.stdout);
    const patch = await git(["diff"], repoDir, 60);
    if (patch.stdout.trim()) {
      await writeFile(
        join(outDir, `${fileKey(task.id)}-${condition}-${rep}.diff.patch`),
        patch.stdout,
      );
    }

    if (condition === "on") {
      try {
        result.trace = summarizeTrace(await readFile(tracePath, "utf8"));
      } catch {
        // A missing trace means no decision was made.
      }
    }

    result.wallMs = Date.now() - started;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.wallMs = Date.now() - started;
    return result;
  } finally {
    if (!keep) await rm(workRoot, { recursive: true, force: true });
    else result.workRoot = workRoot;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.model) {
    throw new Error("--model is required, for example --model anthropic/claude-sonnet-4-5:high");
  }

  const tasksPath = resolve(args.tasks ?? join(HERE, "tasks.example.json"));
  const outRoot = resolve(args.out ?? join(HERE, "results"));
  const reps = Number(args.reps ?? 3);
  if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps must be a positive integer");
  const seed = Number(args.seed ?? 1);
  const tasks = await readTasks(tasksPath);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(seed)}`;
  const outDir = join(outRoot, runId);
  await mkdir(outDir, { recursive: true });

  const extension = resolve(args.extension ?? join(HERE, ".."));
  const tools = args.tools ?? "read,bash,edit,write,grep,find,ls";
  const piCommand = args.pi ?? "pi";
  const keep = args.keep === true;

  const manifest = {
    runId,
    startedAt: new Date().toISOString(),
    tasksPath,
    model: args.model,
    tools,
    extension,
    piCommand,
    reps,
    seed,
    conditions: ["off", "on"],
  };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`run:        ${runId}`);
  console.log(`output:     ${outDir}`);
  console.log(`model:      ${args.model}`);
  console.log(`tasks:      ${tasks.length}`);
  console.log(`reps:       ${reps}`);
  console.log(`conditions: off, on`);
  console.log("");

  for (const task of tasks) {
    for (let rep = 0; rep < reps; rep += 1) {
      for (const condition of shuffledConditions(seed, task.id, rep)) {
        const result = await runOne({
          task,
          condition,
          rep,
          runId,
          outDir,
          model: args.model,
          tools,
          extension,
          piCommand,
          keep,
        });
        await appendFile(
          join(outDir, "runs.jsonl"),
          `${JSON.stringify(result)}\n`,
        );
        const status = result.success ? "PASS" : "FAIL";
        const wall = result.wallMs === null ? "?" : `${result.wallMs}ms`;
        console.log(
          `${status} ${task.id} [${condition}] rep=${rep} wall=${wall}` +
            (result.error ? ` error=${result.error.split("\n")[0]}` : ""),
        );
      }
    }
  }

  console.log("");
  console.log(`Results: ${join(outDir, "runs.jsonl")}`);
  console.log(`Analyze: node bench/analyze.mjs --runs ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
