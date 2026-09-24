export const ENVIRONMENT_IDS = ["go", "python", "node", "pnpm", "kubectl", "aws"] as const;

export type EnvironmentId = typeof ENVIRONMENT_IDS[number];
export type EnvironmentSource = "local" | "managed";

export interface RequestedEnvironment {
  id: EnvironmentId;
  requestedVersion?: string;
  implicit?: true;
}

export interface ResolvedEnvironment {
  id: EnvironmentId;
  version: string;
  source: EnvironmentSource;
  binDirectories: string[];
  env: Record<string, string | undefined>;
  allowRead: string[];
  /**
   * Roots the profile needs writable (for example the host Go module and build
   * caches). Writable roots are implicitly readable; leave unset or empty when
   * the profile only needs read access.
   */
  allowWrite?: string[];
}

export interface EnvironmentPlan {
  platform: string;
  profiles: ResolvedEnvironment[];
  env: Record<string, string | undefined>;
  allowRead: string[];
  allowWrite: string[];
}
