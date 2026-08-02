import type { ConnectionRetryPolicy } from "./authorization.ts";
import type { ProcessResult } from "./remote-process.ts";

export type ConnectionRetryMode = "connect" | "transport";
export type RetriedProcessResult = ProcessResult & { attempts: number };

const CONNECT_FAILURE =
  /ssh: (?:could not resolve hostname|connect to host .*: (?:connection timed out|connection refused|network is unreachable|no route to host))|kex_exchange_identification:.*(?:closed|reset)|ssh_exchange_identification:.*connection reset|banner exchange:.*(?:closed|broken pipe)|connection closed by .* port \d+/i;
const TRANSPORT_FAILURE =
  /broken pipe|client_loop: send disconnect|connection (?:to .* )?closed|connection reset by peer/i;
const AUTHENTICATION_FAILURE =
  /permission denied|authentication failed|password:|keyboard-interactive/i;
const HOST_KEY_FAILURE =
  /host key verification failed|remote host identification has changed|no .* host key is known for .* strict checking|offending .* key in /i;

export async function runWithConnectionRetry(
  run: () => Promise<ProcessResult>,
  policy: ConnectionRetryPolicy,
  mode: ConnectionRetryMode,
  signal?: AbortSignal,
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void> = waitForRetry,
): Promise<RetriedProcessResult> {
  let result: ProcessResult;
  for (let attempt = 0; ; attempt += 1) {
    result = await run();
    const attempts = attempt + 1;
    if (
      attempt >= policy.retries ||
      signal?.aborted ||
      !isRetryableConnectionFailure(result, mode)
    ) {
      return { ...result, attempts };
    }
    const delay = Math.min(10_000, policy.retryDelayMs * 2 ** attempt);
    await wait(delay, signal);
  }
}

export function isRetryableConnectionFailure(
  result: ProcessResult,
  mode: ConnectionRetryMode,
): boolean {
  if (result.exitCode !== 255 || result.aborted || result.timedOut) return false;
  const message = result.stderr.toString("utf8");
  return (
    CONNECT_FAILURE.test(message) ||
    AUTHENTICATION_FAILURE.test(message) ||
    HOST_KEY_FAILURE.test(message) ||
    (mode === "transport" && TRANSPORT_FAILURE.test(message))
  );
}

async function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("SSH retry cancelled.");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("SSH retry cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
