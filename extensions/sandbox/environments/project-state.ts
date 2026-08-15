import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentMount, EnvironmentPlan } from "./types.ts";

const GUEST_PROJECT_ENV = "/var/pi-env";
const GUEST_PYTHON_VENV = `${GUEST_PROJECT_ENV}/python`;
const GUEST_PNPM_HOME = `${GUEST_PROJECT_ENV}/pnpm-home`;
const GUEST_PNPM_STORE = `${GUEST_PROJECT_ENV}/pnpm-store`;

export interface AppleProjectStateOptions {
  workspace: string;
  root: string;
}

export async function prepareAppleProjectState(
  plan: EnvironmentPlan,
  options: AppleProjectStateOptions,
): Promise<void> {
  if (plan.backend !== "apple-container") {
    throw new Error("Apple project state can only augment an Apple Container environment plan");
  }
  const python = plan.profiles.find((profile) => profile.id === "python");
  const pnpm = plan.profiles.find((profile) => profile.id === "pnpm");
  if (!python && !pnpm) return;

  const workspace = await realpath(options.workspace);
  const projectKey = createHash("sha256").update(workspace).digest("hex");
  const projectRoot = join(options.root, projectKey);
  await secureDirectory(projectRoot);

  if (python || pnpm) {
    const environmentRoot = join(projectRoot, "environment");
    await secureDirectory(environmentRoot);
    addMount(plan, { source: environmentRoot, target: GUEST_PROJECT_ENV, readonly: false });
  }
  const pathEntries: string[] = [];
  if (python) {
    const runtimeDirectory = python.binDirectories[0];
    if (!runtimeDirectory) throw new Error("Managed Python profile has no runtime bin directory");
    plan.env.VIRTUAL_ENV = GUEST_PYTHON_VENV;
    plan.guestBootstrap = {
      ...plan.guestBootstrap,
      pythonVenv: {
        runtime: `${runtimeDirectory}/python`,
        venv: GUEST_PYTHON_VENV,
      },
    };
    pathEntries.push(`${GUEST_PYTHON_VENV}/bin`);
  }
  if (pnpm) {
    await secureDirectory(join(projectRoot, "environment", "pnpm-store"));
    await secureDirectory(join(projectRoot, "environment", "pnpm-home"));
    plan.env.PNPM_HOME = GUEST_PNPM_HOME;
    plan.env.npm_config_store_dir = GUEST_PNPM_STORE;
    plan.env.pnpm_config_store_dir = GUEST_PNPM_STORE;
    pathEntries.push(GUEST_PNPM_HOME);
  }
  const existingPath = plan.env.PATH;
  if (typeof existingPath !== "string" || existingPath === "") {
    throw new Error("Apple environment plan is missing PATH");
  }
  plan.env.PATH = [...pathEntries, existingPath].join(":");
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Project environment state is not a real directory: ${path}`);
  }
}

function addMount(plan: EnvironmentPlan, mount: EnvironmentMount): void {
  const mounts = plan.mounts ??= [];
  const conflict = mounts.find((existing) => existing.target === mount.target);
  if (conflict) {
    if (
      conflict.source !== mount.source
      || conflict.readonly !== mount.readonly
    ) {
      throw new Error(`Conflicting Apple project-state mount: ${mount.target}`);
    }
    return;
  }
  mounts.push(mount);
}
