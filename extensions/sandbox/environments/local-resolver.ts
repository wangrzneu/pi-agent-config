import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  EnvironmentId,
  RequestedEnvironment,
  ResolvedEnvironment,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const PYTHON_PROBE = [
  "import json, platform, sys",
  "print(json.dumps({",
  "  'executable': sys.executable,",
  "  'prefix': sys.prefix,",
  "  'basePrefix': sys.base_prefix,",
  "  'version': platform.python_version(),",
  "}))",
].join("\n");

export interface LocalEnvironmentProbe {
  findExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  isExecutable(path: string): Promise<boolean>;
  canonicalize(path: string): Promise<string>;
  run(
    executable: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<string>;
}

export interface LocalEnvironmentResolutionContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  probe?: LocalEnvironmentProbe;
}

export async function resolveLocalEnvironments(
  requested: RequestedEnvironment[],
  context: LocalEnvironmentResolutionContext,
): Promise<ResolvedEnvironment[]> {
  const probe = context.probe ?? nodeLocalEnvironmentProbe;
  const resolved: ResolvedEnvironment[] = [];

  for (const selection of requested) {
    const profile = await resolveOne(selection, context, probe);
    assertRequestedVersion(selection, profile.version);
    resolved.push(profile);
  }
  return resolved;
}

const nodeLocalEnvironmentProbe: LocalEnvironmentProbe = {
  async findExecutable(command, env) {
    const path = env.PATH ?? "";
    for (const directory of path.split(delimiter)) {
      if (!directory) continue;
      const candidate = join(directory, command);
      if (await isExecutable(candidate)) return candidate;
    }
    return undefined;
  },
  isExecutable,
  canonicalize(path) {
    return realpath(path);
  },
  async run(executable, args, env) {
    const result = await execFileAsync(executable, args, {
      env: env ?? process.env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });
    return result.stdout;
  },
};

async function resolveOne(
  requested: RequestedEnvironment,
  context: LocalEnvironmentResolutionContext,
  probe: LocalEnvironmentProbe,
): Promise<ResolvedEnvironment> {
  switch (requested.id) {
    case "go":
      return resolveGo(context.cwd, context.env, probe);
    case "python":
      return resolvePython(context.cwd, context.env, probe);
    case "node":
      return resolveSimpleVersionedTool("node", ["--version"], context.cwd, context.env, probe);
    case "pnpm":
      return resolveSimpleVersionedTool("pnpm", ["--version"], context.cwd, context.env, probe);
    case "kubectl":
      return resolveKubectl(context.cwd, context.env, probe);
  }
}

async function resolveGo(
  cwd: string,
  env: NodeJS.ProcessEnv,
  probe: LocalEnvironmentProbe,
): Promise<ResolvedEnvironment> {
  const executable = await requireExecutable("go", cwd, env, probe);
  const output = await probe.run(executable, ["env", "-json", "GOROOT", "GOVERSION"], {
    ...env,
    GOENV: "off",
  });
  const parsed = parseJsonRecord(output, "go env");
  if (typeof parsed.GOROOT !== "string" || typeof parsed.GOVERSION !== "string") {
    throw new Error("go env did not return GOROOT and GOVERSION");
  }
  const root = await probe.canonicalize(parsed.GOROOT);
  return {
    id: "go",
    version: normalizeVersion("go", parsed.GOVERSION),
    source: "local",
    binDirectories: [join(root, "bin")],
    env: { GOROOT: root, GOENV: "off" },
    allowRead: [root],
  };
}

async function resolvePython(
  cwd: string,
  env: NodeJS.ProcessEnv,
  probe: LocalEnvironmentProbe,
): Promise<ResolvedEnvironment> {
  // Do not execute a project-created .venv interpreter in the trusted Pi
  // process during startup. An already active VIRTUAL_ENV is inherited from
  // the user's launch environment; otherwise resolve Python only from PATH.
  const activePython = env.VIRTUAL_ENV
    ? join(env.VIRTUAL_ENV, "bin", "python")
    : undefined;
  let executable = activePython && await probe.isExecutable(activePython)
    ? activePython
    : undefined;
  executable ??= await probe.findExecutable("python3", env);
  if (!executable) throw new Error("python executable was not found in VIRTUAL_ENV or PATH");
  if (executable !== activePython) await assertOutsideWorkspace(executable, cwd, probe);

  const output = await probe.run(executable, ["-I", "-S", "-c", PYTHON_PROBE], env);
  const parsed = parseJsonRecord(output, "python probe");
  for (const key of ["executable", "prefix", "basePrefix", "version"] as const) {
    if (typeof parsed[key] !== "string") throw new Error(`python probe did not return ${key}`);
  }
  const [canonicalExecutable, prefix, basePrefix] = await Promise.all([
    probe.canonicalize(parsed.executable as string),
    probe.canonicalize(parsed.prefix as string),
    probe.canonicalize(parsed.basePrefix as string),
  ]);
  const virtualEnvironment = prefix !== basePrefix ? prefix : undefined;
  return {
    id: "python",
    version: normalizeVersion("python", parsed.version as string),
    source: "local",
    binDirectories: [dirname(canonicalExecutable)],
    env: {
      ...(virtualEnvironment ? { VIRTUAL_ENV: virtualEnvironment } : {}),
      PYTHONNOUSERSITE: "1",
      PYTHONPATH: undefined,
      PYTHONHOME: undefined,
    },
    allowRead: unique([prefix, basePrefix]),
  };
}

async function resolveSimpleVersionedTool(
  id: "node" | "pnpm",
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  probe: LocalEnvironmentProbe,
): Promise<ResolvedEnvironment> {
  const commandPath = await requireExecutable(id, cwd, env, probe);
  const [canonicalExecutable, output] = await Promise.all([
    probe.canonicalize(commandPath),
    probe.run(commandPath, args, env),
  ]);
  const root = installationRoot(id, canonicalExecutable);
  return {
    id,
    version: normalizeVersion(id, output.trim()),
    source: "local",
    binDirectories: [dirname(commandPath)],
    env: {},
    allowRead: [root],
  };
}

async function resolveKubectl(
  cwd: string,
  env: NodeJS.ProcessEnv,
  probe: LocalEnvironmentProbe,
): Promise<ResolvedEnvironment> {
  const commandPath = await requireExecutable("kubectl", cwd, env, probe);
  const [canonicalExecutable, output] = await Promise.all([
    probe.canonicalize(commandPath),
    probe.run(commandPath, ["version", "--client", "-o", "json"], env),
  ]);
  const parsed = parseJsonRecord(output, "kubectl version");
  const clientVersion = typeof parsed.clientVersion === "object" && parsed.clientVersion !== null
    ? (parsed.clientVersion as Record<string, unknown>).gitVersion
    : undefined;
  if (typeof clientVersion !== "string") throw new Error("kubectl version did not return clientVersion.gitVersion");
  return {
    id: "kubectl",
    version: normalizeVersion("kubectl", clientVersion),
    source: "local",
    binDirectories: [dirname(commandPath)],
    env: {},
    allowRead: [dirname(canonicalExecutable)],
  };
}

async function requireExecutable(
  command: EnvironmentId,
  cwd: string,
  env: NodeJS.ProcessEnv,
  probe: LocalEnvironmentProbe,
): Promise<string> {
  const executable = await probe.findExecutable(command, env);
  if (!executable) throw new Error(`${command} executable was not found in PATH`);
  await assertOutsideWorkspace(executable, cwd, probe);
  return executable;
}

async function assertOutsideWorkspace(
  executable: string,
  cwd: string,
  probe: LocalEnvironmentProbe,
): Promise<void> {
  const canonical = await probe.canonicalize(executable);
  const relation = relative(resolve(cwd), resolve(canonical));
  const inside = relation === ""
    || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
  if (inside) {
    throw new Error(`Refusing to execute a development tool inside the workspace during trusted startup: ${canonical}`);
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function installationRoot(id: "node" | "pnpm", executable: string): string {
  if (id === "pnpm") {
    const marker = `${sep}lib${sep}node_modules${sep}pnpm${sep}`;
    const index = executable.indexOf(marker);
    if (index > 0) return executable.slice(0, index);
  }
  return dirname(dirname(executable));
}

function assertRequestedVersion(requested: RequestedEnvironment, actual: string): void {
  if (requested.requestedVersion === undefined) return;
  const expected = normalizeVersion(requested.id, requested.requestedVersion);
  if (expected !== actual) {
    throw new Error(
      `${requested.id} requested ${expected}, but the local runtime is ${actual}; a matching managed runtime is required`,
    );
  }
}

function normalizeVersion(id: EnvironmentId, version: string): string {
  const trimmed = version.trim();
  if (id === "go") return trimmed.replace(/^go/, "");
  if (id === "node" || id === "kubectl") return trimmed.replace(/^v/, "");
  return trimmed;
}

function parseJsonRecord(value: string, source: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Use the single fail-closed error below.
  }
  throw new Error(`${source} returned invalid JSON`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
