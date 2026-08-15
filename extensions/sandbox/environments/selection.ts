import {
  ENVIRONMENT_IDS,
  type EnvironmentId,
  type RequestedEnvironment,
} from "./types.ts";

const ENVIRONMENT_ORDER = new Map<EnvironmentId, number>(
  ENVIRONMENT_IDS.map((id, index) => [id, index]),
);
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

interface ProfileVersion {
  version?: string;
}

export interface EnvironmentSelectionConfig {
  selected: string[];
  profiles: Record<EnvironmentId, ProfileVersion>;
}

export function resolveEnvironmentSelection(
  flagValue: boolean | string | undefined,
  config: EnvironmentSelectionConfig,
): RequestedEnvironment[] {
  const hasFlag = typeof flagValue === "string" && flagValue.trim() !== "";
  const tokens = hasFlag
    ? parseFlagTokens(flagValue)
    : config.selected.map((id) => ({ id: parseEnvironmentId(id), requestedVersion: undefined }));

  if (tokens.some(({ id }) => id === "none")) {
    if (tokens.length !== 1) throw new Error("The sandbox environment 'none' must be selected alone");
    return [];
  }

  const selected = new Map<EnvironmentId, RequestedEnvironment>();
  for (const token of tokens) {
    const id = token.id as EnvironmentId;
    if (selected.has(id)) throw new Error(`Duplicate sandbox environment: ${id}`);
    const configuredVersion = config.profiles[id]?.version;
    selected.set(id, {
      id,
      requestedVersion: token.requestedVersion ?? configuredVersion,
    });
  }

  if (selected.has("pnpm") && !selected.has("node")) {
    selected.set("node", {
      id: "node",
      requestedVersion: config.profiles.node?.version,
      implicit: true,
    });
  }

  return [...selected.values()].sort((left, right) => (
    (ENVIRONMENT_ORDER.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (ENVIRONMENT_ORDER.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function parseFlagTokens(value: string): Array<{
  id: EnvironmentId | "none";
  requestedVersion?: string;
}> {
  const rawTokens = value.split(",").map((token) => token.trim());
  if (rawTokens.some((token) => token === "")) {
    throw new Error("Sandbox environment selection contains an empty entry");
  }
  return rawTokens.map((token) => {
    const separator = token.indexOf("@");
    const rawId = separator < 0 ? token : token.slice(0, separator);
    const rawVersion = separator < 0 ? undefined : token.slice(separator + 1);
    if (rawId === "none") {
      if (rawVersion !== undefined) throw new Error("The sandbox environment 'none' cannot have a version");
      return { id: "none" as const };
    }
    const id = parseEnvironmentId(rawId);
    if (rawVersion !== undefined && !VERSION_PATTERN.test(rawVersion)) {
      throw new Error(`Invalid version for sandbox environment ${id}: ${JSON.stringify(rawVersion)}`);
    }
    return { id, requestedVersion: rawVersion };
  });
}

function parseEnvironmentId(value: string): EnvironmentId {
  if ((ENVIRONMENT_IDS as readonly string[]).includes(value)) return value as EnvironmentId;
  throw new Error(
    `Unknown sandbox environment ${JSON.stringify(value)}; expected ${ENVIRONMENT_IDS.join(", ")}, or none`,
  );
}
