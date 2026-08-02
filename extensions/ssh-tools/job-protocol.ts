import { shellQuote } from "./remote-process.ts";

export type RemoteJobState = "running" | "exited" | "cancelled" | "lost";

export interface StartedJob {
  pid: number;
  directory: string;
}

export interface JobStatus {
  state: RemoteJobState;
  pid: number;
  exitCode?: number;
  stdoutSize: number;
  stderrSize: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export function buildStartJobScript(jobId: string, cwd: string, command: string): string {
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  return `set -eu
umask 077
job_root="\${PI_SSH_JOB_DIR:-\${XDG_STATE_HOME:-$HOME/.local/state}/pi-agent/jobs}"
job_dir="$job_root/${jobId}"
mkdir -p "$job_dir"
decode_base64() {
  if printf '' | base64 -d >/dev/null 2>&1; then base64 -d; else base64 -D; fi
}
printf %s ${shellQuote(encodedCommand)} | decode_base64 > "$job_dir/command"
cat > "$job_dir/runner.sh" <<'PI_SSH_RUNNER'
#!/bin/sh
set -u
job_dir=$1
cwd=$2
if ! cd "$cwd"; then
  printf '%s\n' 125 > "$job_dir/exit_code"
  exit 125
fi
command_text=$(cat "$job_dir/command")
if command -v setsid >/dev/null 2>&1; then
  setsid sh -lc "$command_text" > "$job_dir/stdout" 2> "$job_dir/stderr" < /dev/null &
  printf '%s\n' 1 > "$job_dir/grouped"
else
  sh -lc "$command_text" > "$job_dir/stdout" 2> "$job_dir/stderr" < /dev/null &
  printf '%s\n' 0 > "$job_dir/grouped"
fi
child=$!
printf '%s\n' "$child" > "$job_dir/pid"
set +e
wait "$child"
code=$?
set -e
printf '%s\n' "$code" > "$job_dir/exit_code"
PI_SSH_RUNNER
chmod 700 "$job_dir/runner.sh"
printf '%s\n' ${shellQuote(cwd)} > "$job_dir/cwd"
: > "$job_dir/stdout"
: > "$job_dir/stderr"
nohup "$job_dir/runner.sh" "$job_dir" ${shellQuote(cwd)} > /dev/null 2>&1 < /dev/null &
attempt=0
while [ ! -s "$job_dir/pid" ] && [ "$attempt" -lt 30 ]; do
  sleep 0.1
  attempt=$((attempt + 1))
done
if [ ! -s "$job_dir/pid" ]; then
  printf '%s\n' 'job runner did not start' >&2
  exit 1
fi
job_dir_b64=$(printf %s "$job_dir" | base64 | tr -d '\n')
printf 'PI_JOB\t%s\t%s\n' "$(cat "$job_dir/pid")" "$job_dir_b64"
`;
}

export function parseStartedJob(output: string): StartedJob {
  const line = output.split("\n").find((candidate) => candidate.startsWith("PI_JOB\t"));
  if (!line) throw new Error("Remote job did not return a job marker.");
  const [, pidText, directoryBase64] = line.split("\t");
  const pid = Number(pidText);
  const directory = Buffer.from(directoryBase64 || "", "base64").toString("utf8");
  if (!Number.isSafeInteger(pid) || pid <= 0 || !directory) {
    throw new Error("Remote job returned invalid metadata.");
  }
  return { pid, directory };
}

export function buildJobStatusScript(
  directory: string,
  stdoutOffset: number,
  stderrOffset: number,
  maxBytes: number,
): string {
  return `set -eu
job_dir=${shellQuote(directory)}
test -d "$job_dir"
pid=$(cat "$job_dir/pid")
stdout_size=$(wc -c < "$job_dir/stdout" | tr -d ' ')
stderr_size=$(wc -c < "$job_dir/stderr" | tr -d ' ')
exit_code=''
if [ -s "$job_dir/exit_code" ]; then
  exit_code=$(cat "$job_dir/exit_code")
  if [ -f "$job_dir/cancelled" ]; then state=cancelled; else state=exited; fi
elif kill -0 "$pid" 2>/dev/null; then
  state=running
elif [ -f "$job_dir/cancelled" ]; then
  state=cancelled
else
  state=lost
fi
stdout_b64=$(tail -c +${stdoutOffset + 1} "$job_dir/stdout" | head -c ${maxBytes} | base64 | tr -d '\n')
stderr_b64=$(tail -c +${stderrOffset + 1} "$job_dir/stderr" | head -c ${maxBytes} | base64 | tr -d '\n')
printf 'PI_JOB_STATUS\t%s\t%s\t%s\t%s\t%s\n' "$state" "$pid" "$exit_code" "$stdout_size" "$stderr_size"
printf 'PI_STDOUT\t%s\n' "$stdout_b64"
printf 'PI_STDERR\t%s\n' "$stderr_b64"
`;
}

export function parseJobStatus(output: string): JobStatus {
  const lines = output.split("\n");
  const metadata = lines.find((line) => line.startsWith("PI_JOB_STATUS\t"));
  if (!metadata) throw new Error("Remote job did not return status metadata.");
  const [, stateText, pidText, exitText, stdoutSizeText, stderrSizeText] = metadata.split("\t");
  if (!isRemoteJobState(stateText)) throw new Error("Remote job returned an invalid state.");

  const pid = Number(pidText);
  const stdoutSize = Number(stdoutSizeText);
  const stderrSize = Number(stderrSizeText);
  const exitCode = exitText === "" ? undefined : Number(exitText);
  if (![pid, stdoutSize, stderrSize].every(Number.isSafeInteger)) {
    throw new Error("Remote job returned invalid numeric metadata.");
  }
  if (exitCode !== undefined && !Number.isSafeInteger(exitCode)) {
    throw new Error("Remote job returned an invalid exit code.");
  }

  const stdout = decodeLine(lines, "PI_STDOUT\t");
  const stderr = decodeLine(lines, "PI_STDERR\t");
  return {
    state: stateText,
    pid,
    ...(exitCode === undefined ? {} : { exitCode }),
    stdoutSize,
    stderrSize,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
  };
}

export function buildCancelJobScript(directory: string, graceSeconds: number): string {
  return `set -eu
job_dir=${shellQuote(directory)}
test -d "$job_dir"
pid=$(cat "$job_dir/pid")
if [ -s "$job_dir/exit_code" ] || ! kill -0 "$pid" 2>/dev/null; then
  printf 'PI_JOB_CANCEL\talready-stopped\n'
  exit 0
fi
: > "$job_dir/cancelled"
target="$pid"
if [ "$(cat "$job_dir/grouped" 2>/dev/null || printf 0)" = 1 ]; then target="-$pid"; fi
kill -TERM -- "$target" 2>/dev/null || true
attempt=0
limit=${graceSeconds * 10}
while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt "$limit" ]; do
  sleep 0.1
  attempt=$((attempt + 1))
done
if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "$target" 2>/dev/null || true; fi
printf 'PI_JOB_CANCEL\tcancelled\n'
`;
}

function decodeLine(lines: readonly string[], prefix: string): Buffer {
  const encoded = lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "";
  return Buffer.from(encoded, "base64");
}

function isRemoteJobState(value: string | undefined): value is RemoteJobState {
  return value === "running" || value === "exited" || value === "cancelled" || value === "lost";
}
