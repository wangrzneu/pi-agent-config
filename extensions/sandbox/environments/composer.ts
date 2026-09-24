import type {
  EnvironmentPlan,
  ResolvedEnvironment,
} from "./types.ts";

export interface EnvironmentCompositionBase {
  platform: string;
  basePath: string[];
}

export function composeEnvironmentPlan(
  base: EnvironmentCompositionBase,
  profiles: ResolvedEnvironment[],
): EnvironmentPlan {
  const ids = new Set<string>();
  const pathEntries: string[] = [];
  const allowRead: string[] = [];
  const allowWrite: string[] = [];
  const env = new Map<string, { value: string | undefined; owner: string }>();

  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`Duplicate resolved sandbox environment: ${profile.id}`);
    ids.add(profile.id);
    pathEntries.push(...profile.binDirectories);
    // A writable root must also be readable: macOS Seatbelt grants read and
    // write as separate rules, so a write-only grant would still block reads.
    allowRead.push(...profile.allowRead, ...(profile.allowWrite ?? []));
    allowWrite.push(...(profile.allowWrite ?? []));

    for (const [name, value] of Object.entries(profile.env)) {
      if (name === "PATH") {
        throw new Error(`Sandbox environment ${profile.id} must use binDirectories instead of setting PATH`);
      }
      const previous = env.get(name);
      if (previous && previous.value !== value) {
        throw new Error(
          `Conflicting environment variable ${name}: ${previous.owner} and ${profile.id} requested different values`,
        );
      }
      env.set(name, { value, owner: profile.id });
    }
  }

  pathEntries.push(...base.basePath);
  const composedEnv: Record<string, string | undefined> = {};
  for (const [name, entry] of env) composedEnv[name] = entry.value;
  composedEnv.PATH = unique(pathEntries).join(":");

  return {
    platform: base.platform,
    profiles: [...profiles],
    env: composedEnv,
    allowRead: unique(allowRead),
    allowWrite: unique(allowWrite),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}
