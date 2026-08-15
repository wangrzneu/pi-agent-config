import { lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const PYTHON_RUNTIME = /^\/opt\/pi-toolchains\/python\/[0-9A-Za-z.-]+\/bin\/python$/;
const PYTHON_VENV = "/var/pi-env/python";

export function validateGuestBootstrap(bootstrap) {
  if (bootstrap === undefined) return;
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) {
    throw new Error("Invalid guest environment bootstrap");
  }
  const keys = Object.keys(bootstrap);
  if (keys.some((key) => key !== "pythonVenv")) throw new Error("Unknown guest environment bootstrap");
  if (bootstrap.pythonVenv === undefined) return;
  const request = bootstrap.pythonVenv;
  if (
    !request
    || typeof request !== "object"
    || Array.isArray(request)
    || !PYTHON_RUNTIME.test(request.runtime)
    || request.venv !== PYTHON_VENV
    || Object.keys(request).some((key) => key !== "runtime" && key !== "venv")
  ) {
    throw new Error("Invalid Python guest venv bootstrap");
  }
}

export async function bootstrapGuestEnvironment(bootstrap, run) {
  validateGuestBootstrap(bootstrap);
  const request = bootstrap?.pythonVenv;
  if (!request || await hasPython(request.venv)) return;

  const parent = dirname(request.venv);
  const staging = await mkdtemp(join(parent, ".python-staging-"));
  try {
    await run([request.runtime, "-I", "-m", "venv", "--without-pip", staging]);
    await run([join(staging, "bin", "python"), "-I", "-m", "ensurepip", "--upgrade"]);
    if (await pathExists(request.venv)) {
      if (await hasPython(request.venv)) return;
      await rm(request.venv, { recursive: true, force: true });
    }
    try {
      await rename(staging, request.venv);
    } catch (error) {
      if (!await hasPython(request.venv)) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function hasPython(venv) {
  try {
    const metadata = await lstat(join(venv, "bin", "python"));
    return metadata.isFile() || metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
