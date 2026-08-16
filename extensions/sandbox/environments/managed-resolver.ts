import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { composeEnvironmentPlan } from "./composer.ts";
import { EnvironmentStore } from "./store.ts";
import type {
  EnvironmentId,
  EnvironmentMount,
  EnvironmentPlan,
  RequestedEnvironment,
  ResolvedEnvironment,
} from "./types.ts";

const APPLE_BASE_PATH = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];

export interface ManagedEnvironmentResolutionContext {
  store: EnvironmentStore;
  platform: string;
}

export function managedExactVersionMessage(ids: readonly EnvironmentId[]): string {
  const uniqueIds = [...new Set(ids)];
  return [
    `Managed runtimes require an exact version: ${uniqueIds.join(", ")}.`,
    `Pin each with --sandbox-env ${uniqueIds.map((id) => `${id}@<version>`).join(",")}`,
    "or developmentEnvironments.profiles.<id>.version.",
  ].join(" ");
}

export async function resolveStoredEnvironments(
  requested: RequestedEnvironment[],
  context: ManagedEnvironmentResolutionContext,
): Promise<ResolvedEnvironment[]> {
  await context.store.initialize();
  const profiles: ResolvedEnvironment[] = [];
  for (const selection of requested) {
    const { version, objectPath } = await resolveStoredObject(selection, context);
    profiles.push(managedProfile(selection.id, version, objectPath));
  }
  return profiles;
}

export async function resolveManagedEnvironmentPlan(
  requested: RequestedEnvironment[],
  context: ManagedEnvironmentResolutionContext,
): Promise<EnvironmentPlan> {
  await context.store.initialize();
  const profiles: ResolvedEnvironment[] = [];
  const mounts: EnvironmentMount[] = [];

  for (const selection of requested) {
    const { version, objectPath } = await resolveStoredObject(selection, context);
    const target = `/opt/pi-toolchains/${selection.id}/${version}`;
    profiles.push(managedProfile(selection.id, version, target));
    mounts.push({ source: objectPath, target, readonly: true });
  }

  const plan = composeEnvironmentPlan({
    backend: "apple-container",
    platform: context.platform,
    shimDirectory: "/opt/pi-shims",
    basePath: APPLE_BASE_PATH,
  }, profiles);
  return { ...plan, mounts };
}

async function resolveStoredObject(
  selection: RequestedEnvironment,
  context: ManagedEnvironmentResolutionContext,
): Promise<{ version: string; objectPath: string }> {
  const version = selection.requestedVersion;
  if (!version) throw new Error(managedExactVersionMessage([selection.id]));
  const objectPath = await context.store.resolve(context.platform, selection.id, version);
  if (!objectPath) {
    throw new Error(
      `${selection.id}@${version} for ${context.platform} is not installed in the managed environment store`,
    );
  }
  const executableName = profileExecutable(selection.id);
  const executable = join(objectPath, "bin", executableName);
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new Error(`Managed environment object is missing executable bin/${executableName}: ${objectPath}`);
  }
  return { version, objectPath };
}

function managedProfile(
  id: EnvironmentId,
  version: string,
  target: string,
): ResolvedEnvironment {
  const env: Record<string, string | undefined> = {};
  if (id === "go") {
    env.GOROOT = target;
    env.GOENV = "off";
  } else if (id === "python") {
    env.PYTHONNOUSERSITE = "1";
    env.PYTHONPATH = undefined;
    env.PYTHONHOME = undefined;
  }
  return {
    id,
    version,
    source: "managed",
    binDirectories: [join(target, "bin")],
    env,
    allowRead: [target],
  };
}

function profileExecutable(id: EnvironmentId): string {
  // Keep this explicit so a future profile cannot turn a config value into a
  // path. pnpm objects contain a fixed launcher bound to the selected Node.
  switch (id) {
    case "go": return "go";
    case "python": return "python";
    case "node": return "node";
    case "pnpm": return "pnpm";
    case "kubectl": return "kubectl";
  }
}

