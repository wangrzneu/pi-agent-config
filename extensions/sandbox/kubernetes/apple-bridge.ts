import { execFile } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AppleGatewayResolutionOptions {
  /** Absolute path to the Apple `container` CLI. When present, the actual NAT
   * gateway is read from `container network inspect default` instead of being
   * guessed from host bridge interfaces (which are not stable across service
   * restarts). */
  containerBinary?: string;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  run?: (binary: string, args: string[]) => Promise<string>;
}

export async function resolveAppleContainerHostGateway(
  options: AppleGatewayResolutionOptions = {},
): Promise<string> {
  if (options.containerBinary) {
    try {
      const run = options.run ?? runContainerCli;
      const stdout = await run(options.containerBinary, ["network", "inspect", "default"]);
      const gateway = parseIpv4Gateway(stdout);
      if (gateway) return gateway;
    } catch {
      // Fall back to the interface heuristic when the CLI is unavailable.
    }
  }
  return gatewayFromBridgeInterfaces(options.interfaces ?? networkInterfaces());
}

async function runContainerCli(binary: string, args: string[]): Promise<string> {
  const result = await execFileAsync(binary, args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

function parseIpv4Gateway(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const status = parsed[0]?.status;
    if (typeof status !== "object" || status === null) return undefined;
    const gateway = (status as Record<string, unknown>).ipv4Gateway;
    return typeof gateway === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(gateway)
      ? gateway
      : undefined;
  } catch {
    return undefined;
  }
}

function gatewayFromBridgeInterfaces(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  const entries = Object.entries(interfaces);
  const bridgeEntries = entries.some(([name]) => name === "bridge100")
    ? entries.filter(([name]) => name === "bridge100")
    : entries.filter(([name]) => /^bridge\d+$/.test(name));
  const candidates = bridgeEntries
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address)
    .filter((address) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address));
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) {
    throw new Error(
      `Unable to identify a unique private Apple Container host gateway (${unique.join(", ") || "none"})`,
    );
  }
  return unique[0];
}
