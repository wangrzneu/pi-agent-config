import { delimiter } from "node:path";
import type { DevelopmentEnvironmentsConfig, EnvironmentInstallMode } from "../config.ts";
import { installTrustedRuntime } from "./artifact-catalog.ts";
import { composeEnvironmentPlan } from "./composer.ts";
import type { RuntimeInstallerOptions } from "./installer.ts";
import { resolveLocalEnvironments } from "./local-resolver.ts";
import { resolveStoredEnvironments } from "./managed-resolver.ts";
import { EnvironmentStore } from "./store.ts";
import type {
  EnvironmentId,
  EnvironmentPlan,
  RequestedEnvironment,
  ResolvedEnvironment,
} from "./types.ts";

export interface ProcessEnvironmentResolutionOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: string;
  store: EnvironmentStore;
  config: DevelopmentEnvironmentsConfig;
  localResolver?: typeof resolveLocalEnvironments;
  installer?: typeof installTrustedRuntime;
  installerOptions?: RuntimeInstallerOptions;
  approveInstall?: (requested: RequestedEnvironment[]) => Promise<boolean>;
}

export interface ManagedObjectProvisioningOptions {
  store: EnvironmentStore;
  platform: string;
  installMode: EnvironmentInstallMode;
  installer?: typeof installTrustedRuntime;
  installerOptions?: RuntimeInstallerOptions;
  approveInstall?: (requested: RequestedEnvironment[]) => Promise<boolean>;
}

export async function resolveProcessEnvironmentPlan(
  requested: RequestedEnvironment[],
  options: ProcessEnvironmentResolutionOptions,
): Promise<EnvironmentPlan> {
  const localResolver = options.localResolver ?? resolveLocalEnvironments;
  const profilesById = new Map<EnvironmentId, ResolvedEnvironment>();
  const managedRequests: RequestedEnvironment[] = [];

  for (const request of requested) {
    const source = configuredSource(request.id, options.config);
    if (source === "managed") {
      managedRequests.push(request);
      continue;
    }
    try {
      const [profile] = await localResolver([request], { cwd: options.cwd, env: options.env });
      if (!profile) throw new Error(`${request.id} local resolver returned no profile`);
      profilesById.set(request.id, profile);
    } catch (error) {
      if (source === "local") throw error;
      managedRequests.push(request);
    }
  }

  if (managedRequests.length > 0) {
    await provisionManagedObjects(managedRequests, {
      store: options.store,
      platform: options.platform,
      installMode: options.config.install.mode,
      installer: options.installer,
      installerOptions: options.installerOptions,
      approveInstall: options.approveInstall,
    });
    const managedProfiles = await resolveStoredEnvironments(managedRequests, {
      store: options.store,
      platform: options.platform,
    });
    for (const profile of managedProfiles) profilesById.set(profile.id, profile);
  }

  const profiles = requested.map((request) => {
    const profile = profilesById.get(request.id);
    if (!profile) throw new Error(`No Process environment profile was resolved for ${request.id}`);
    return profile;
  });
  return composeEnvironmentPlan({
    backend: "process",
    platform: options.platform,
    basePath: (options.env.PATH ?? "").split(delimiter).filter(Boolean),
  }, profiles);
}

export async function provisionManagedObjects(
  requested: RequestedEnvironment[],
  options: ManagedObjectProvisioningOptions,
): Promise<void> {
  await options.store.initialize();
  const missing: RequestedEnvironment[] = [];
  for (const request of requested) {
    if (!request.requestedVersion) continue;
    const existing = await options.store.resolve(options.platform, request.id, request.requestedVersion);
    if (!existing) missing.push(request);
  }
  if (missing.length === 0 || options.installMode === "never") return;
  if (options.installMode === "ask") {
    if (!options.approveInstall || !await options.approveInstall(missing)) {
      throw new Error("Managed runtime installation was not approved");
    }
  }
  const installer = options.installer ?? installTrustedRuntime;
  for (const request of missing) {
    await installer(
      options.store,
      request.id,
      request.requestedVersion!,
      options.platform,
      options.installerOptions,
    );
  }
}

function configuredSource(
  id: EnvironmentId,
  config: DevelopmentEnvironmentsConfig,
): "auto" | "local" | "managed" {
  if (id === "pnpm") return "auto";
  const source = config.profiles[id].source;
  return source === "project-venv-or-managed" ? "auto" : source;
}
