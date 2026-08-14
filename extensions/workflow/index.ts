import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  CAPABILITIES,
  approveWorkflow,
  cancelWorkflow,
  createWorkflow,
  failStep,
  getNextStep,
  pauseWorkflow,
  passStep,
  recoverWorkflow,
  restoreWorkflow,
  resumeWorkflow,
  startStep,
  type Workflow,
  type WorkflowStepInput,
} from "./workflow-state.ts";

export const WORKFLOW_CUSTOM_TYPE = "pi-agent-config-workflow";
const OPEN_STATUSES = new Set(["pending_approval", "active", "paused"]);
const RESUMABLE_SESSION_REASONS = new Set(["startup", "resume", "reload"]);

const workflowInputSchema = Type.Object({
  action: StringEnum(["create", "start", "pass", "fail", "pause", "resume", "cancel", "status"] as const),
  goal: Type.Optional(Type.String()),
  stepId: Type.Optional(Type.String()),
  verificationResult: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  maxRetriesPerStep: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  steps: Type.Optional(Type.Array(Type.Object({
    id: Type.String(),
    title: Type.String(),
    instruction: Type.String(),
    requiredCapabilities: Type.Optional(Type.Array(StringEnum(CAPABILITIES))),
    dependsOn: Type.Optional(Type.Array(Type.String())),
    verification: Type.Optional(Type.String()),
  }))),
});

type WorkflowToolInput = {
  action: "create" | "start" | "pass" | "fail" | "pause" | "resume" | "cancel" | "status";
  goal?: string;
  stepId?: string;
  verificationResult?: string;
  error?: string;
  reason?: string;
  maxRetriesPerStep?: number;
  maxSteps?: number;
  steps?: WorkflowStepInput[];
};

interface PersistedWorkflowEntry {
  schemaVersion: 1;
  workflow: Workflow;
}

export default function workflowExtension(pi: ExtensionAPI): void {
  let workflow: Workflow | undefined;
  let autoResumeSent = false;

  const notifyStatus = (ctx: ExtensionContext): void => {
    if (!workflow) {
      ctx.ui.setStatus("workflow", undefined);
      return;
    }
    const next = getNextStep(workflow);
    const label = workflow.status === "active" && next
      ? `${workflow.status}: ${next.title}`
      : workflow.status;
    ctx.ui.setStatus("workflow", ` workflow · ${label}`);
  };

  const persist = (): void => {
    if (!workflow) return;
    const data: PersistedWorkflowEntry = { schemaVersion: 1, workflow };
    pi.appendEntry(WORKFLOW_CUSTOM_TYPE, data);
  };

  const restoreFromContext = (ctx: ExtensionContext): void => {
    workflow = undefined;
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
    for (const entry of entries) {
      if (entry?.type !== "custom" || entry.customType !== WORKFLOW_CUSTOM_TYPE) continue;
      const data = entry.data as Partial<PersistedWorkflowEntry> | undefined;
      const restored = restoreWorkflow(data?.workflow);
      if (restored) workflow = restored;
    }
  };

  const result = (text: string, details: Record<string, unknown> = {}) => ({
    content: [{ type: "text" as const, text }],
    details: { ...details, workflow },
  });

  const requireCurrent = (): Workflow => {
    if (!workflow || !OPEN_STATUSES.has(workflow.status)) {
      throw new Error("There is no open workflow.");
    }
    return workflow;
  };

  const approveCurrent = (ctx: ExtensionContext, continueAgent = false): Workflow => {
    if (!workflow) throw new Error("There is no workflow awaiting approval.");
    workflow = approveWorkflow(workflow);
    persist();
    notifyStatus(ctx);
    if (continueAgent && typeof pi.sendMessage === "function") {
      void pi.sendMessage(
        {
          customType: WORKFLOW_CUSTOM_TYPE,
          content: "The workflow was approved. Execute its next pending step.",
          display: false,
          details: { workflowId: workflow.id },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
    return workflow;
  };

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Create and update the current structured task workflow. The workflow is temporary, persisted in the Pi session, and supports bounded retries and restart recovery.",
    promptSnippet: "Create or update a temporary structured workflow for multi-step tasks",
    promptGuidelines: [
      "Use workflow before changing files when the task has multiple dependent actions or requires explicit verification.",
      "Use workflow start before executing a step, and use workflow pass only after performing and checking that step's verification condition.",
      "Use workflow fail with a concrete error when a step cannot be verified; the workflow enforces the retry budget.",
      "Workflow capabilities describe required actions but never grant permissions; existing tool and sandbox authorization still applies."
    ],
    parameters: workflowInputSchema,
    async execute(_toolCallId, input: WorkflowToolInput, _signal, _onUpdate, ctx) {
      const now = new Date().toISOString();
      switch (input.action) {
        case "create": {
          if (workflow && OPEN_STATUSES.has(workflow.status)) {
            throw new Error("An active workflow already exists. Complete, cancel, or pause it first.");
          }
          if (!input.goal || !input.steps) throw new Error("Creating a workflow requires goal and steps.");
          workflow = createWorkflow({
            goal: input.goal,
            steps: input.steps,
            maxRetriesPerStep: input.maxRetriesPerStep,
            maxSteps: input.maxSteps,
          }, now);
          persist();
          notifyStatus(ctx);
          const preview = renderWorkflow(workflow);
          if (ctx.hasUI && await ctx.ui.confirm("Approve workflow?", preview)) {
            return result(`Workflow ${approveCurrent(ctx).id} approved. Execute its next pending step.`);
          }
          return { ...result(`Workflow ${workflow.id} is awaiting approval. Preview:\n${preview}`), terminate: true };
        }
        case "status":
          return result(renderWorkflow(workflow), { currentStep: workflow ? getNextStep(workflow)?.id : undefined });
        case "start": {
          if (!input.stepId) throw new Error("Starting a workflow step requires stepId.");
          workflow = startStep(requireCurrent(), input.stepId, now);
          persist();
          notifyStatus(ctx);
          return result(`Workflow step ${input.stepId} started.`);
        }
        case "pass": {
          if (!input.stepId || !input.verificationResult) {
            throw new Error("Passing a workflow step requires stepId and verificationResult.");
          }
          workflow = passStep(requireCurrent(), input.stepId, input.verificationResult, now);
          persist();
          notifyStatus(ctx);
          return result(workflow.status === "completed"
            ? `Workflow ${workflow.id} completed.`
            : `Workflow step ${input.stepId} passed.`, { nextStep: getNextStep(workflow)?.id });
        }
        case "fail": {
          if (!input.stepId || !input.error) throw new Error("Failing a workflow step requires stepId and error.");
          workflow = failStep(requireCurrent(), input.stepId, input.error, now);
          persist();
          notifyStatus(ctx);
          return result(workflow.status === "paused"
            ? `Workflow paused: retry budget exhausted for ${input.stepId}.`
            : `Workflow step ${input.stepId} failed; retry ${workflow.steps.find((step) => step.id === input.stepId)!.retries} is available.`);
        }
        case "pause":
          workflow = pauseWorkflow(requireCurrent(), input.reason ?? "Paused by workflow controller.", now);
          persist();
          notifyStatus(ctx);
          return result(`Workflow ${workflow.id} paused.`);
        case "resume":
          workflow = resumeWorkflow(requireCurrent(), now);
          persist();
          notifyStatus(ctx);
          return result(`Workflow ${workflow.id} resumed. Next step: ${getNextStep(workflow)?.id ?? "none"}.`);
        case "cancel":
          workflow = cancelWorkflow(requireCurrent(), now);
          persist();
          notifyStatus(ctx);
          return result(`Workflow ${workflow.id} cancelled.`);
      }
    },
  });

  pi.registerCommand("workflow", {
    description: "Show or control the current workflow: status, pause, resume, cancel",
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (!action || action === "status") {
          ctx.ui.notify(renderWorkflow(workflow), "info");
          return;
        }
        if (action === "approve") {
          if (workflow?.status !== "pending_approval") {
            ctx.ui.notify("No workflow is awaiting approval.", "warning");
            return;
          }
          approveCurrent(ctx, true);
          ctx.ui.notify(renderWorkflow(workflow), "info");
          return;
        }
        if (action === "pause") {
          workflow = pauseWorkflow(requireCurrent(), rest.join(" ") || "Paused by user.");
          persist();
        } else if (action === "resume") {
          workflow = resumeWorkflow(requireCurrent());
          persist();
        } else if (action === "cancel") {
          workflow = cancelWorkflow(requireCurrent());
          persist();
        } else {
          ctx.ui.notify("Usage: /workflow [status|approve|pause|resume|cancel]", "info");
          return;
        }
        notifyStatus(ctx);
        ctx.ui.notify(renderWorkflow(workflow), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    restoreFromContext(ctx);
    if (workflow?.status === "active") {
      const recovered = recoverWorkflow(workflow);
      if (recovered.updatedAt !== workflow.updatedAt || recovered.resumeReason !== workflow.resumeReason) {
        workflow = recovered;
        persist();
      }
    }
    notifyStatus(ctx);

    if (
      workflow?.status === "active" &&
      RESUMABLE_SESSION_REASONS.has(event.reason) &&
      !autoResumeSent &&
      typeof pi.sendMessage === "function"
    ) {
      autoResumeSent = true;
      void pi.sendMessage(
        {
          customType: WORKFLOW_CUSTOM_TYPE,
          content: "A persisted workflow is active. Resume it from its next pending step; do not create a second workflow.",
          display: false,
          details: { workflowId: workflow.id },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const content = workflow?.status === "active"
      ? buildExecutionInstructions(workflow)
      : workflow?.status === "pending_approval"
        ? buildApprovalInstructions(workflow)
        : workflow?.status === "paused"
          ? buildPausedInstructions(workflow)
          : buildDetectionInstructions();
    return {
      message: {
        customType: WORKFLOW_CUSTOM_TYPE,
        display: false,
        content,
        details: workflow ? { workflowId: workflow.id } : { mode: "detection" },
      },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    notifyStatus(ctx);
  });
}

export function renderWorkflow(workflow: Workflow | undefined): string {
  if (!workflow) return "No active workflow.";
  const lines = [
    `Workflow ${workflow.id} (${workflow.status})`,
    `Goal: ${workflow.goal}`,
  ];
  for (const [index, step] of workflow.steps.entries()) {
    const retry = step.retries > 0 ? `, retries=${step.retries}` : "";
    lines.push(`${index + 1}. [${step.status}] ${step.title}${retry}`);
    lines.push(`   Instruction: ${step.instruction}`);
    if (step.dependsOn.length > 0) lines.push(`   Depends on: ${step.dependsOn.join(", ")}`);
    if (step.requiredCapabilities.length > 0) lines.push(`   Capabilities: ${step.requiredCapabilities.join(", ")}`);
    if (step.verification) lines.push(`   Verification: ${step.verification}`);
    if (step.lastError) lines.push(`   Error: ${step.lastError}`);
  }
  if (workflow.resumeReason) lines.push(`Resume: ${workflow.resumeReason}`);
  return lines.join("\n");
}

function buildDetectionInstructions(): string {
  return [
    "Workflow controller: automatically decide whether the user's task needs a workflow.",
    "Use a workflow for multiple dependent actions or tasks that need explicit verification; simple one-action requests may use the normal loop.",
    "If a workflow is appropriate, call workflow with action=create before modifying files or performing external actions.",
    "Create concrete steps with dependencies, requiredCapabilities, and a verification condition. Do not create an arbitrary shell script and do not grant yourself permissions.",
  ].join("\n");
}

function buildApprovalInstructions(workflow: Workflow): string {
  return [
    `Workflow ${workflow.id} is awaiting approval for goal: ${workflow.goal}.`,
    "Show or refer to the workflow preview, but do not execute any step until the user approves it with the approval dialog or /workflow approve.",
  ].join("\\n");
}

function buildPausedInstructions(workflow: Workflow): string {
  return [
    `Workflow ${workflow.id} is paused for goal: ${workflow.goal}.`,
    `Reason: ${workflow.resumeReason ?? "No reason recorded."}`,
    "Do not execute workflow steps while paused. Ask the user to resume or cancel it, or report the retry budget failure.",
  ].join("\n");
}

function buildExecutionInstructions(workflow: Workflow): string {
  const next = getNextStep(workflow);
  return [
    `Workflow controller: continue workflow ${workflow.id} for goal: ${workflow.goal}`,
    "Do not create another workflow. Execute only the next unblocked step and keep the existing step order.",
    next
      ? `Next step: ${next.id} — ${next.title}\nInstruction: ${next.instruction}\nVerification: ${next.verification || "State what you checked."}\nCapabilities requested: ${next.requiredCapabilities.join(", ") || "none"}`
      : "There is no unblocked pending step. Inspect status and report why the workflow cannot continue.",
    "Call workflow start before the step, perform the work with normal tools, then call workflow pass only after verification. On failure call workflow fail with the concrete reason.",
    "Do not bypass sandbox, credential prompts, or other tool gates. A workflow capability is a request label, not a permission grant."
  ].join("\n");
}
