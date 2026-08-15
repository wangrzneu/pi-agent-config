export interface SanitizedKubernetesGrant {
  context: string;
  cluster: string;
  namespace?: string;
  gatewayServer: string;
  gatewayCaData: string;
  capability: string;
}

export function createSanitizedKubeconfig(
  grants: SanitizedKubernetesGrant[],
  currentContext?: string,
): string {
  const names = new Set<string>();
  for (const grant of grants) {
    if (!grant.context) throw new Error("Kubernetes context name cannot be empty");
    if (names.has(grant.context)) throw new Error(`Duplicate Kubernetes context grant: ${grant.context}`);
    names.add(grant.context);
    validateGatewayServer(grant.gatewayServer, grant.context);
    if (!grant.capability) throw new Error(`Kubernetes context ${grant.context} has an empty capability`);
  }
  if (currentContext !== undefined && !names.has(currentContext)) {
    throw new Error(`Kubernetes current context ${currentContext} is not granted`);
  }

  const config = {
    apiVersion: "v1",
    kind: "Config",
    preferences: {},
    clusters: grants.map((grant, index) => ({
      name: `pi-session-cluster-${index}`,
      cluster: {
        server: grant.gatewayServer,
        ...(grant.gatewayCaData
          ? { "certificate-authority-data": grant.gatewayCaData }
          : {}),
      },
    })),
    users: grants.map((grant, index) => ({
      name: `pi-session-user-${index}`,
      user: { token: grant.capability },
    })),
    contexts: grants.map((grant, index) => ({
      name: grant.context,
      context: {
        cluster: `pi-session-cluster-${index}`,
        user: `pi-session-user-${index}`,
        ...(grant.namespace ? { namespace: grant.namespace } : {}),
      },
    })),
    "current-context": currentContext ?? grants[0]?.context ?? "",
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function validateGatewayServer(server: string, context: string): void {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error(`Kubernetes context ${context} has an invalid gateway server URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Kubernetes context ${context} has an unsupported gateway server protocol`);
  }
}
