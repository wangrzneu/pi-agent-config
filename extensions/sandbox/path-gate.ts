import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SandboxPathAuthorization } from "./path-authorization.ts";

export type PathAccess = "read" | "write";

export const PATH_ACCESS_META: Record<PathAccess, {
  action: string;
  activity: string;
  tools: string;
  phrase: string;
}> = {
  read: {
    action: "read",
    activity: "reading",
    tools: "bash, read, grep, find, or ls",
    phrase: "Reading",
  },
  write: {
    action: "write to",
    activity: "writing",
    tools: "bash, write, or edit",
    phrase: "Writing",
  },
};

export function registerPathAuthorizationTool(
  pi: ExtensionAPI,
  access: PathAccess,
  authorization: SandboxPathAuthorization,
): void {
  const meta = PATH_ACCESS_META[access];
  pi.registerTool({
    name: `sandbox_authorize_${access}`,
    label: `Authorize sandbox ${access}`,
    description: `Request explicit user approval to ${meta.action} files or directories outside the current workspace for this session. Call this before using ${meta.tools} on external paths.`,
    promptSnippet: `Request user authorization before ${meta.activity} paths outside the workspace`,
    promptGuidelines: [
      `Use sandbox_authorize_${access} before any ${meta.tools} operation that needs to ${meta.action} a path outside the current workspace.`,
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 8,
        uniqueItems: true,
      }),
      reason: Type.String({
        description: `Why ${access} access to these external paths is needed`,
        minLength: 1,
        maxLength: 500,
      }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error(`${meta.phrase} authorization cancelled.`);
      const paths = await authorizePaths(
        authorization,
        params.paths,
        params.reason,
        access,
        ctx,
      );
      return {
        content: [{
          type: "text",
          text: `Authorized external ${access} access for this session:\n${paths.join("\n")}`,
        }],
        details: { access, paths, reason: params.reason },
      };
    },
  });
}

export async function authorizePaths(
  authorization: SandboxPathAuthorization,
  rawPaths: string[],
  reason: string,
  access: PathAccess,
  ctx: ExtensionContext,
): Promise<string[]> {
  const candidates = await Promise.all(rawPaths.map((path) =>
    authorization.inspect(path, ctx.cwd, { allowMissing: access === "write" })
  ));
  const unique = [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()];
  const newGrants = [];
  for (const candidate of unique) {
    if (!(await authorization.isAllowed(candidate.path, ctx.cwd))) newGrants.push(candidate);
  }

  if (newGrants.length > 0) {
    if (!ctx.hasUI) throw new Error(`External ${access} authorization requires an interactive approval.`);
    const approved = await ctx.ui.confirm(
      `Allow external file ${access} access?`,
      `${reason}\n\n${newGrants.map((grant) => grant.path).join("\n")}\n\nAccess lasts until this session is reloaded or closed.`,
    );
    if (!approved) throw new Error(`External ${access} authorization was not approved.`);
    for (const grant of newGrants) authorization.grant(grant);
  }

  return unique.map((candidate) => candidate.path);
}

export function fileAccessPath(
  toolName: string,
  input: Record<string, unknown>,
): { kind: PathAccess; path: string } | undefined {
  if (["read", "grep", "find", "ls"].includes(toolName)) {
    return { kind: "read", path: typeof input.path === "string" ? input.path : "." };
  }
  if (["write", "edit"].includes(toolName) && typeof input.path === "string") {
    return { kind: "write", path: input.path };
  }
  return undefined;
}
