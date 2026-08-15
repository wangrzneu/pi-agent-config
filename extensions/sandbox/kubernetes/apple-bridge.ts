import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export function resolveAppleContainerHostGateway(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
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
