# A/B testing

Status: implemented harness, opt-in. See
[`docs/improvement-plan.md`](improvement-plan.md) for the broader roadmap.

The harness answers one question: **does System One improve task success enough to
justify its latency and cost?** It runs the same prompt twice on fresh clones:

- `off`: `PI_SYSTEM_ONE_ENABLED=0`
- `on`: `PI_SYSTEM_ONE_ENABLED=1`

Both arms set `PI_WORK_STATUS_CLASSIFIER=0` so the work-status model classifier is
not a second uncontrolled variable. With System One on, work-status still reuses
the shared decision for its footer; that is part of the treatment.

## Requirements

- `pi` on `PATH`, or pass `--pi /path/to/pi`.
- The package path passed to `-e`; the default is this repository.
- A fixed model selection, for example
  `--model anthropic/claude-sonnet-4-5:high`.
- TypeSafe credentials (`TYPESAFE_API_KEY`) or a classifier provider already
  configured in Pi. The harness does not print credentials.
- A task file with repositories, commits, prompts, setup commands, and tests.

Task commands are trusted shell commands. Run the harness only on repositories
and task files you trust. Use absolute paths for local repositories; relative
paths are passed to `git clone` from the harness process cwd.

## Task file

```json
[
  {
    "id": "fix-null-auth",
    "repo": "https://github.com/your-org/your-repo",
    "commit": "abc123",
    "workdir": ".",
    "setup": "npm ci",
    "prompt": "Fix the null dereference in the login flow and add a regression test.",
    "test": "npm test",
    "timeoutSec": 900,
    "setupTimeoutSec": 1800,
    "testTimeoutSec": 900,
    "category": "bugfix",
    "difficulty": "medium",
    "env": { "CI": "1" }
  }
]
```

Fields:

| Field | Required | Meaning |
|---|---:|---|
| `id` | yes | Stable task id; used in result keys and filenames. |
| `repo` | yes | Git URL or absolute local repository path accepted by `git clone`. |
| `commit` | no | Commit/ref to check out; default `HEAD`. |
| `workdir` | no | Subdirectory where setup, Pi, and tests run. |
| `setup` | no | Shell command run before Pi. |
| `prompt` | yes | The user prompt sent to Pi. |
| `test` | no | Success command run after Pi. Default success is Pi exit 0. |
| `timeoutSec` | no | Pi timeout; default 900. |
| `setupTimeoutSec` | no | Setup timeout; default 1800. |
| `testTimeoutSec` | no | Test timeout; default 900. |
| `category` | no | Used for stratified reports, e.g. `bugfix`, `refactor`, `security`, `state`, `performance`. |
| `difficulty` | no | Free-form difficulty label, e.g. `small`, `medium`, `large`. |
| `env` | no | Extra environment values for setup, Pi, and tests. |

See [`bench/tasks.example.json`](../bench/tasks.example.json).

## Run

```bash
node bench/run.mjs \
  --tasks bench/tasks.example.json \
  --model anthropic/claude-sonnet-4-5:high \
  --reps 3 \
  --seed 1 \
  --out bench/results
```

Useful options:

| Option | Default | Meaning |
|---|---|---|
| `--tasks` | `bench/tasks.example.json` | Task file. |
| `--out` | `bench/results` | Output root. Each invocation gets a timestamped run dir. |
| `--model` | required | Fixed model and thinking level. |
| `--tools` | `read,bash,edit,write,grep,find,ls` | Fixed tool selection. |
| `--extension` | this repository | Package path passed to `-e`. |
| `--pi` | `pi` | Pi executable. |
| `--reps` | `3` | Repetitions per task. |
| `--seed` | `1` | Controls condition order. |
| `--keep` | false | Keep temporary clones for inspection. |

For each run the harness:

1. Clones the repository into a fresh temporary directory.
2. Checks out the task commit.
3. Runs `setup`.
4. Runs Pi with `--mode json --no-session --no-extensions`, the fixed
   model/tools/prompt, and only the package passed through `-e`. This prevents a
   globally installed copy of the package from loading twice and conflicting on
   tool/flag names.
5. Parses turn/tool/usage events.
6. Runs the task test command.
7. Captures `git diff --numstat` and the patch.
8. Writes one JSON result and appends it to `runs.jsonl`.

The default tool list does **not** include `context_select`. Add it explicitly
when you want to measure that feature, and expect the control arm to warn about
an unknown tool if System One is off.

## Analyze

```bash
node bench/analyze.mjs --runs bench/results/<run-id>
# or
node bench/analyze.mjs --runs bench/results/<run-id>/runs.jsonl --out report.md
```

The report includes:

- success rate by arm
- success/Pi-time/token summary by `category`
- paired McNemar test (`off fail → on success` vs `off success → on fail`)
- success-delta bootstrap confidence interval
- median and p95 wall time
- median turns and tool calls
- total tokens and cost
- wall-time delta bootstrap confidence interval

## Metrics and decision rules

Primary metric:

- **task success**: test command exit 0 (or Pi exit 0 when no test is set).

Secondary metrics:

- wall time (p50/p95), not just mean
- turns and tool calls
- tokens and cost
- diff size
- System One trace: decisions, cache hits, failures, median/p95 decision latency
- for human runs: interventions, flow score, NASA-TLX, review burden

A reasonable decision rule:

- Default on only if success improves by a meaningful margin, the confidence
  interval excludes zero, and p95 latency/cost are acceptable.
- Keep opt-in if success is flat but latency or cost rises.
- Restrict to high-risk tasks if only auth/db/migration subsets improve.
- Roll back if decision timeouts exceed 5% or extra self-check turns exceed 20%.

## Pilot status

An expanded pilot used eight tasks from [`bench/pilot/tasks.json`](../bench/pilot/tasks.json),
one repetition, and `openai-codex/gpt-5.6-luna`:

- off 7/8 success (87.5%); on 8/8 (100%);
- one swap (plan-mode tools off fail/on success); McNemar b=1, c=0, p=1.0;
- median Pi time: 226 s off / 223 s on; p95: 447 s / 442 s;
- total tokens: 12.3M off / 14.6M on; cost: 0.451 / 0.492;
- System One: 3–9 decisions per run, no decision failures;
- median decision latency: ~0.6 s.

This is still a small pilot, not evidence that System One improves coding
performance. The only success difference is one state-management task, while
the on arm used more tokens and cost. Increase repetitions and use harder, more
varied tasks before drawing conclusions.

## Limitations

- The harness measures automated task success, not human “vibe” or flow.
- LLM runs are stochastic; use repetitions and paired analysis.
- Provider and model versions drift; record them with the results.
- Existing tests can be insufficient; add hidden checks or use a benchmark such
  as SWE-bench Verified with augmented tests.
- `git clone` + setup per run can dominate wall time. Measure Pi time separately
  (`piMs`) for latency comparisons.
- The control arm is “System One disabled”, not “no model requests at all”:
  work-status is pinned off, but other extensions and Pi itself still run.
- A result is only as good as the task file. Avoid tasks that are trivially easy,
  already solved, or impossible for both arms.
