import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { EnvironmentStore } from "./store.ts";
import { hasTrustedManagedCatalog, noManagedCatalogMessage } from "./artifact-catalog.ts";
import { goCacheProfileFragment } from "./go-cache.ts";
import type {
  EnvironmentId,
  RequestedEnvironment,
  ResolvedEnvironment,
} from "./types.ts";

export interface ManagedEnvironmentResolutionContext {
  store: EnvironmentStore;
  platform: string;
  /** Host environment used to resolve Go cache roots; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
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
  const hostEnv = context.env ?? process.env;
  const profiles: ResolvedEnvironment[] = [];
  for (const selection of requested) {
    const { version, objectPath } = await resolveStoredObject(selection, context);
    profiles.push(managedProfile(selection.id, version, objectPath, hostEnv));
  }
  return profiles;
}

async function resolveStoredObject(
  selection: RequestedEnvironment,
  context: ManagedEnvironmentResolutionContext,
): Promise<{ version: string; objectPath: string }> {
  // Fail closed before any version-pin messaging for profiles without a
  // trusted managed catalog; the rationale lives on hasTrustedManagedCatalog.
  if (!hasTrustedManagedCatalog(selection.id)) {
    throw new Error(noManagedCatalogMessage(selection.id));
  }
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
  hostEnv: NodeJS.ProcessEnv,
): ResolvedEnvironment {
  const env: Record<string, string | undefined> = {};
  const allowRead: string[] = [target];
  let allowWrite: string[] | undefined;
  if (id === "go") {
    const cache = goCacheProfileFragment(hostEnv);
    env.GOROOT = target;
    env.GOENV = "off";
    // Managed Go reuses the same host module/build caches as a local one.
    Object.assign(env, cache.env);
    allowRead.push(...cache.allowRead);
    allowWrite = cache.allowWrite;
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
    allowRead,
    allowWrite,
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
    case "aws": return "aws";
  }
}
