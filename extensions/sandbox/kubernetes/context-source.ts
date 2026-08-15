import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type KubernetesAuthenticationKind =
  | "exec"
  | "auth-provider"
  | "token"
  | "client-certificate"
  | "basic"
  | "unknown";

export interface KubernetesContextMetadata {
  name: string;
  cluster: string;
  server: string;
  user: string;
  namespace?: string;
  authentication: KubernetesAuthenticationKind;
  execCommand?: string;
  execArgs?: string[];
  execEnvironmentNames?: string[];
}

export interface KubernetesContextDiscovery {
  currentContext?: string;
  contexts: KubernetesContextMetadata[];
}

export interface KubernetesContextSourceOptions {
  kubectl: string;
  env: NodeJS.ProcessEnv;
  run?: (executable: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

export async function discoverKubernetesContexts(
  options: KubernetesContextSourceOptions,
): Promise<KubernetesContextDiscovery> {
  const run = options.run ?? runCommand;
  // Deliberately omit --raw: kubectl redacts credential material. The parser
  // below also projects only non-secret metadata into the returned objects.
  const output = await run(options.kubectl, ["config", "view", "-o", "json"], options.env);
  const config = parseRecord(output);
  const clusters = namedEntries(config.clusters);
  const users = namedEntries(config.users);
  const contexts = namedEntries(config.contexts);

  const discovered = contexts.map(({ name, value }) => {
    const context = recordProperty(value, "context");
    const clusterName = stringProperty(context, "cluster");
    const userName = stringProperty(context, "user");
    const cluster = clusters.find((entry) => entry.name === clusterName);
    if (!cluster) throw new Error(`Kubernetes context ${name} references unknown cluster ${clusterName}`);
    const user = users.find((entry) => entry.name === userName);
    if (!user) throw new Error(`Kubernetes context ${name} references unknown user ${userName}`);
    const clusterConfig = recordProperty(cluster.value, "cluster");
    const userConfig = recordProperty(user.value, "user");
    const server = stringProperty(clusterConfig, "server");
    validateServer(server, name);
    const authentication = authenticationMetadata(userConfig);
    return {
      name,
      cluster: clusterName,
      server,
      user: userName,
      namespace: optionalStringProperty(context, "namespace"),
      authentication: authentication.kind,
      execCommand: authentication.execCommand,
      execArgs: authentication.execArgs,
      execEnvironmentNames: authentication.execEnvironmentNames,
    } satisfies KubernetesContextMetadata;
  });

  return {
    currentContext: optionalStringProperty(config, "current-context"),
    contexts: discovered,
  };
}

async function runCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFileAsync(executable, args, {
    env,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
  });
  return result.stdout;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Use the redacted error below; never include raw kubeconfig output.
  }
  throw new Error("kubectl config view returned invalid JSON");
}

function namedEntries(value: unknown): Array<{ name: string; value: Record<string, unknown> }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("kubectl config view returned an invalid named entry list");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("kubectl config view returned an invalid named entry");
    }
    const record = entry as Record<string, unknown>;
    return { name: stringProperty(record, "name"), value: record };
  });
}

function authenticationMetadata(user: Record<string, unknown>): {
  kind: KubernetesAuthenticationKind;
  execCommand?: string;
  execArgs?: string[];
  execEnvironmentNames?: string[];
} {
  if (typeof user.exec === "object" && user.exec !== null && !Array.isArray(user.exec)) {
    const exec = user.exec as Record<string, unknown>;
    return {
      kind: "exec",
      execCommand: optionalStringProperty(exec, "command"),
      execArgs: optionalStringArrayProperty(exec, "args") ?? [],
      execEnvironmentNames: execEnvironmentNames(exec.env),
    };
  }
  if (user["auth-provider"] !== undefined) return { kind: "auth-provider" };
  if (user.token !== undefined || user.tokenFile !== undefined) return { kind: "token" };
  if (user["client-certificate"] !== undefined || user["client-certificate-data"] !== undefined) {
    return { kind: "client-certificate" };
  }
  if (user.username !== undefined || user.password !== undefined) return { kind: "basic" };
  return { kind: "unknown" };
}

function optionalStringArrayProperty(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || /[\0\r\n]/.test(entry))) {
    throw new Error(`kubectl config view has invalid string list ${key}`);
  }
  return [...value];
}

function execEnvironmentNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("kubectl config view has invalid exec environment");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("kubectl config view has invalid exec environment entry");
    }
    return stringProperty(entry as Record<string, unknown>, "name");
  });
}

function recordProperty(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`kubectl config view is missing object ${key}`);
  }
  return value as Record<string, unknown>;
}

function stringProperty(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`kubectl config view is missing string ${key}`);
  }
  return value;
}

function optionalStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function validateServer(server: string, context: string): void {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error(`Kubernetes context ${context} has an invalid API server URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Kubernetes context ${context} uses an unsupported API server protocol`);
  }
}
