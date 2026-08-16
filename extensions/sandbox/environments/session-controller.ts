import type { DevelopmentEnvironmentsConfig, EnvironmentInstallMode } from "../config.ts";
import { installTrustedRuntime } from "./artifact-catalog.ts";
import type { RuntimeInstallerOptions } from "./installer.ts";
import { resolveLocalEnvironments } from "./local-resolver.ts";
import { resolveManagedEnvironmentPlan } from "./managed-resolver.ts";
import { prepareAppleProjectState } from "./project-state.ts";
import {
  provisionManagedObjects,
  resolveProcessEnvironmentPlan,
} from "./process-resolver.ts";
import { EnvironmentStore, parseEnvironmentStoreSize } from "./store.ts";
import type { EnvironmentPlan, RequestedEnvironment } from "./types.ts";

export interface EnvironmentSessionControllerOptions {
  store: EnvironmentStore;
  projectStateRoot: string;
  localResolver?: typeof resolveLocalEnvironments;
  managedResolver?: typeof resolveManagedEnvironmentPlan;
  installer?: typeof installTrustedRuntime;
}

export interface EnvironmentResolutionContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  config: DevelopmentEnvironmentsConfig;
  installerOptions: RuntimeInstallerOptions;
  approveInstall: (missing: RequestedEnvironment[]) => Promise<boolean>;
}

export class SandboxEnvironmentSessionController {
  private readonly options: EnvironmentSessionControllerOptions;
  private activePlan?: EnvironmentPlan;
  private leaseId?: string;

  constructor(options: EnvironmentSessionControllerOptions) {
    this.options = options;
  }

  get plan(): EnvironmentPlan | undefined {
    return this.activePlan;
  }

  async resolveProcess(
    requested: RequestedEnvironment[],
    context: EnvironmentResolutionContext,
  ): Promise<EnvironmentPlan | undefined> {
    if (requested.length === 0) return undefined;
    return resolveProcessEnvironmentPlan(requested, {
      cwd: context.cwd,
      env: context.env,
      platform: `${process.platform}-${process.arch}`,
      store: this.options.store,
      config: context.config,
      localResolver: this.options.localResolver,
      installer: this.options.installer,
      installerOptions: context.installerOptions,
      approveInstall: context.approveInstall,
    });
  }

  async resolveApple(
    requested: RequestedEnvironment[],
    context: EnvironmentResolutionContext,
  ): Promise<EnvironmentPlan | undefined> {
    if (requested.length === 0) return undefined;
    const unpinned = requested.filter((request) => !request.requestedVersion);
    if (unpinned.length > 0) {
      throw new Error(
        `Apple Container managed runtimes require an exact version: ${unpinned.map((request) => request.id).join(", ")}. Pin each with --sandbox-env ${unpinned.map((request) => `${request.id}@<version>`).join(",")} or developmentEnvironments.profiles versions, or use the Process backend.`,
      );
    }
    if (!this.options.managedResolver) {
      await provisionManagedObjects(requested, {
        store: this.options.store,
        platform: "linux-arm64",
        installMode: context.config.install.mode,
        installer: this.options.installer,
        installerOptions: context.installerOptions,
        approveInstall: context.approveInstall,
      });
    }
    const plan = await (this.options.managedResolver ?? resolveManagedEnvironmentPlan)(
      requested,
      { store: this.options.store, platform: "linux-arm64" },
    );
    await prepareAppleProjectState(plan, {
      workspace: context.cwd,
      root: this.options.projectStateRoot,
    });
    return plan;
  }

  async activate(
    plan: EnvironmentPlan | undefined,
    sessionId: string,
    config: DevelopmentEnvironmentsConfig,
  ): Promise<void> {
    await this.releaseLease();
    this.activePlan = plan;
    const managedProfiles = plan?.profiles.filter((profile) => profile.source === "managed") ?? [];
    if (managedProfiles.length > 0 && !this.options.managedResolver) {
      this.leaseId = `${sessionId}:${process.pid}`;
      for (const profile of managedProfiles) {
        await this.options.store.acquireLease(
          this.leaseId,
          plan!.platform,
          profile.id,
          profile.version,
        );
      }
    }
    await this.options.store.prune({
      maxBytes: parseEnvironmentStoreSize(config.install.maxSize),
      retentionDays: config.install.retentionDays,
    });
  }

  async reset(): Promise<void> {
    await this.releaseLease();
    this.activePlan = undefined;
  }

  async status(): Promise<Awaited<ReturnType<EnvironmentStore["status"]>>> {
    return this.options.store.status();
  }

  async prune(config: {
    mode?: EnvironmentInstallMode;
    maxSize: string;
    retentionDays: number;
  }, removeAll: boolean): Promise<Awaited<ReturnType<EnvironmentStore["prune"]>>> {
    return this.options.store.prune({
      maxBytes: removeAll ? 0 : parseEnvironmentStoreSize(config.maxSize),
      retentionDays: removeAll ? 0 : config.retentionDays,
    });
  }

  private async releaseLease(): Promise<void> {
    if (this.leaseId) await this.options.store.releaseLease(this.leaseId).catch(() => undefined);
    this.leaseId = undefined;
  }
}
