export const ENVIRONMENT_IDS = ["go", "python", "node", "pnpm", "kubectl"] as const;

export type EnvironmentId = typeof ENVIRONMENT_IDS[number];
export type EnvironmentBackend = "process" | "apple-container";
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
}

export interface EnvironmentMount {
  source: string;
  target: string;
  readonly: boolean;
}

export interface GuestEnvironmentBootstrap {
  pythonVenv?: {
    runtime: string;
    venv: string;
  };
}

export interface EnvironmentPlan {
  backend: EnvironmentBackend;
  platform: string;
  profiles: ResolvedEnvironment[];
  env: Record<string, string | undefined>;
  allowRead: string[];
  mounts?: EnvironmentMount[];
  guestBootstrap?: GuestEnvironmentBootstrap;
}
