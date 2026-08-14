export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export const CAPABILITIES = [
  "read",
  "write",
  "test",
  "network",
] as const;

export type WorkflowCapability = (typeof CAPABILITIES)[number];
export type WorkflowStatus = "pending_approval" | "active" | "paused" | "completed" | "cancelled";
export type WorkflowStepStatus = "pending" | "running" | "passed" | "failed";

export interface WorkflowStepInput {
  id: string;
  title: string;
  instruction: string;
  requiredCapabilities?: WorkflowCapability[];
  dependsOn?: string[];
  verification?: string;
}

export interface WorkflowInput {
  id?: string;
  goal: string;
  steps: WorkflowStepInput[];
  maxRetriesPerStep?: number;
  maxSteps?: number;
}

export interface WorkflowStep extends Required<Omit<WorkflowStepInput, "requiredCapabilities" | "dependsOn" | "verification">> {
  requiredCapabilities: WorkflowCapability[];
  dependsOn: string[];
  verification: string;
  status: WorkflowStepStatus;
  retries: number;
  lastError?: string;
  verificationResult?: string;
}

export interface Workflow {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  maxRetriesPerStep: number;
  maxSteps: number;
  resumeReason?: string;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_STEPS = 20;
const MAX_RETRIES = 10;
const MAX_STEPS = 100;
const CAPABILITY_SET = new Set<string>(CAPABILITIES);

export function normalizeWorkflow(input: WorkflowInput): WorkflowInput {
  if (!input || typeof input !== "object") throw new Error("Workflow must be an object.");
  const goal = requireText(input.goal, "goal");
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error("Workflow must contain at least one step.");
  }
  const maxSteps = boundedInteger(input.maxSteps, DEFAULT_MAX_STEPS, 1, MAX_STEPS);
  if (input.steps.length > maxSteps) {
    throw new Error(`Workflow contains ${input.steps.length} steps; maximum is ${maxSteps}.`);
  }
  const ids = new Set<string>();
  const steps = input.steps.map((step) => {
    if (!step || typeof step !== "object") throw new Error("Workflow steps must be objects.");
    const id = requireText(step.id, "step id");
    if (ids.has(id)) throw new Error(`Workflow contains duplicate step id: ${id}.`);
    ids.add(id);
    const capabilities = step.requiredCapabilities ?? [];
    if (!Array.isArray(capabilities) || capabilities.some((value) => !CAPABILITY_SET.has(value))) {
      throw new Error(`Workflow step ${id} contains an unknown capability.`);
    }
    const dependsOn = step.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((value) => typeof value !== "string")) {
      throw new Error(`Workflow step ${id} has invalid dependencies.`);
    }
    return {
      id,
      title: requireText(step.title, `title for step ${id}`),
      instruction: requireText(step.instruction, `instruction for step ${id}`),
      requiredCapabilities: [...capabilities],
      dependsOn: [...dependsOn],
      verification: typeof step.verification === "string" ? step.verification.trim() : "",
    };
  });

  const stepIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        throw new Error(`Workflow step ${step.id} has unknown dependency: ${dependency}.`);
      }
      if (dependency === step.id) throw new Error(`Workflow contains a dependency cycle at ${step.id}.`);
    }
  }
  assertAcyclic(steps);

  return {
    id: input.id,
    goal,
    steps,
    maxRetriesPerStep: boundedInteger(input.maxRetriesPerStep, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES),
    maxSteps,
  };
}

export function restoreWorkflow(value: unknown): Workflow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<Workflow>;
  if (raw.schemaVersion !== WORKFLOW_SCHEMA_VERSION || typeof raw.id !== "string") return undefined;
  if (raw.status !== "pending_approval" && raw.status !== "active" && raw.status !== "paused" && raw.status !== "completed" && raw.status !== "cancelled") return undefined;
  if (typeof raw.goal !== "string" || typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") return undefined;
  if (!Array.isArray(raw.steps)) return undefined;
  try {
    const base = normalizeWorkflow({
      id: raw.id,
      goal: raw.goal,
      maxRetriesPerStep: raw.maxRetriesPerStep,
      maxSteps: raw.maxSteps,
      steps: raw.steps.map((step) => ({
        id: step.id,
        title: step.title,
        instruction: step.instruction,
        requiredCapabilities: step.requiredCapabilities,
        dependsOn: step.dependsOn,
        verification: step.verification,
      })),
    });
    const statuses = new Set<WorkflowStepStatus>(["pending", "running", "passed", "failed"]);
    const steps = raw.steps.map((step, index) => {
      if (!statuses.has(step.status as WorkflowStepStatus) || !Number.isInteger(step.retries) || step.retries! < 0) {
        throw new Error("invalid workflow step state");
      }
      return {
        ...base.steps[index],
        status: step.status!,
        retries: step.retries!,
        ...(typeof step.lastError === "string" ? { lastError: step.lastError } : {}),
        ...(typeof step.verificationResult === "string" ? { verificationResult: step.verificationResult } : {}),
      };
    });
    return {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: raw.id,
      goal: raw.goal,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(typeof raw.completedAt === "string" ? { completedAt: raw.completedAt } : {}),
      status: raw.status,
      steps,
      maxRetriesPerStep: base.maxRetriesPerStep!,
      maxSteps: base.maxSteps!,
      ...(typeof raw.resumeReason === "string" ? { resumeReason: raw.resumeReason } : {}),
    };
  } catch {
    return undefined;
  }
}

export function createWorkflow(input: WorkflowInput, now = new Date().toISOString()): Workflow {
  const normalized = normalizeWorkflow(input);
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: normalized.id?.trim() || `workflow-${Date.now().toString(36)}`,
    goal: normalized.goal,
    createdAt: now,
    updatedAt: now,
    status: "pending_approval",
    maxRetriesPerStep: normalized.maxRetriesPerStep!,
    maxSteps: normalized.maxSteps!,
    steps: normalized.steps.map((step) => ({
      ...step,
      status: "pending",
      retries: 0,
    })),
  };
}

export function approveWorkflow(workflow: Workflow, now = new Date().toISOString()): Workflow {
  if (workflow.status !== "pending_approval") throw new Error(`Workflow is ${workflow.status}.`);
  return update({ ...workflow, status: "active" }, now, (steps) => steps);
}

export function getNextStep(workflow: Workflow): WorkflowStep | undefined {
  if (workflow.status !== "active") return undefined;
  const running = workflow.steps.find((step) => step.status === "running");
  if (running) return running;
  return workflow.steps.find(
    (step) => step.status === "pending" && step.dependsOn.every((id) =>
      workflow.steps.some((candidate) => candidate.id === id && candidate.status === "passed"),
    ),
  );
}

export function startStep(workflow: Workflow, stepId: string, now = new Date().toISOString()): Workflow {
  const step = requireStep(workflow, stepId);
  if (workflow.status !== "active") throw new Error(`Workflow is ${workflow.status}.`);
  if (step.status !== "pending") throw new Error(`Workflow step ${stepId} is already ${step.status}.`);
  if (!step.dependsOn.every((id) => workflow.steps.some((candidate) => candidate.id === id && candidate.status === "passed"))) {
    throw new Error(`Workflow step ${stepId} is blocked by an incomplete dependency.`);
  }
  if (workflow.steps.some((candidate) => candidate.status === "running")) {
    throw new Error("Workflow already has a running step.");
  }
  return update(workflow, now, (steps) => steps.map((candidate) =>
    candidate.id === stepId ? { ...candidate, status: "running", lastError: undefined } : candidate,
  ));
}

export function passStep(workflow: Workflow, stepId: string, verificationResult: string, now = new Date().toISOString()): Workflow {
  const step = requireStep(workflow, stepId);
  if (step.status !== "running") throw new Error(`Workflow step ${stepId} is not running.`);
  const next = update(workflow, now, (steps) => steps.map((candidate) =>
    candidate.id === stepId
      ? { ...candidate, status: "passed", verificationResult: requireText(verificationResult, "verification result") }
      : candidate,
  ));
  if (next.steps.every((candidate) => candidate.status === "passed")) {
    return { ...next, status: "completed", completedAt: now };
  }
  return next;
}

export function failStep(workflow: Workflow, stepId: string, error: string, now = new Date().toISOString()): Workflow {
  const step = requireStep(workflow, stepId);
  if (step.status !== "running") throw new Error(`Workflow step ${stepId} is not running.`);
  const retries = step.retries + 1;
  const exhausted = retries > workflow.maxRetriesPerStep;
  const next = update(workflow, now, (steps) => steps.map((candidate) =>
    candidate.id === stepId
      ? {
        ...candidate,
        status: exhausted ? "failed" : "pending",
        retries,
        lastError: requireText(error, "failure reason"),
      }
      : candidate,
  ));
  return exhausted ? { ...next, status: "paused" } : next;
}

export function pauseWorkflow(workflow: Workflow, reason: string, now = new Date().toISOString()): Workflow {
  if (workflow.status !== "active") throw new Error(`Workflow is ${workflow.status}.`);
  return {
    ...update(workflow, now, (steps) => steps.map((step) =>
      step.status === "running" ? { ...step, status: "pending" } : step,
    )),
    status: "paused",
    resumeReason: requireText(reason, "pause reason"),
  };
}

export function resumeWorkflow(workflow: Workflow, now = new Date().toISOString()): Workflow {
  if (workflow.status !== "paused") throw new Error(`Workflow is ${workflow.status}.`);
  return { ...update({ ...workflow, status: "active" }, now, (steps) => steps), resumeReason: undefined };
}

export function cancelWorkflow(workflow: Workflow, now = new Date().toISOString()): Workflow {
  if (workflow.status === "completed" || workflow.status === "cancelled") {
    throw new Error(`Workflow is ${workflow.status}.`);
  }
  return { ...update(workflow, now, (steps) => steps), status: "cancelled" };
}

export function recoverWorkflow(workflow: Workflow, now = new Date().toISOString()): Workflow {
  if (workflow.status !== "active") return workflow;
  const interrupted = workflow.steps.some((step) => step.status === "running");
  if (!interrupted) return workflow;
  return {
    ...update(workflow, now, (steps) => steps.map((step) =>
      step.status === "running" ? { ...step, status: "pending" } : step,
    )),
    resumeReason: "Recovered after an interrupted Pi session.",
  };
}

function requireStep(workflow: Workflow, stepId: string): WorkflowStep {
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Unknown workflow step: ${stepId}.`);
  return step;
}

function update(workflow: Workflow, now: string, map: (steps: WorkflowStep[]) => WorkflowStep[]): Workflow {
  return { ...workflow, steps: map(workflow.steps), updatedAt: now };
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Workflow ${label} must be non-empty.`);
  return value.trim();
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Workflow value must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function assertAcyclic(steps: Array<{ id: string; dependsOn: string[] }>): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Workflow contains a dependency cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}
