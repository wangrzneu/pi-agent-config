# Pilot A/B tasks

These tasks exercise the P0/P1 changes on a clone of this repository at `HEAD`.
They are intentionally small, but each one has an objective hidden check and
fails on the committed baseline.

| Task | What it checks |
|---|---|
| `pilot-plan-allowlist` | plan-mode rejects mutating flags (`tree -o`, `find -fprint`, `less -o`, `date -s`, `rg --pre`, `fd -x`) |
| `pilot-external-memory-recall` | recall works for archives captured without a checkpoint |
| `pilot-system-one-completion` | completion self-check uses `agent_before_settle` + `continue: true` |
| `pilot-system-one-risk-batch` | parallel edits produce one batched risk decision |
| `pilot-work-status-nonblocking` | `before_agent_start` is not blocked by the classifier |
| `pilot-system-one-registry` | System One client uses Pi's classifier registry, not direct `fetch` |
| `pilot-plan-mode-tools` | plan mode preserves non-write tools, keeps newly activated tools, and persists state |
| `pilot-external-memory-tool-off` | `/memory off` deactivates `memory_recall` |

Run the pilot:

```bash
node bench/run.mjs \
  --tasks bench/pilot/tasks.json \
  --model openai-codex/gpt-5.6-luna \
  --reps 1 \
  --seed 1

node bench/analyze.mjs --runs bench/results/<run-id>
```

The tasks use `repo: "../.."` and resolve relative to this file. Setup symlinks
the source repository's `node_modules` through `PI_AB_SOURCE_REPO`, so the
hidden checks can import local modules without a full install.

An expanded pilot (8 tasks, 1 repetition, `openai-codex/gpt-5.6-luna`) produced:

- off 7/8 success (87.5%); on 8/8 (100%);
- one swap: plan-mode tools failed off/passed on; McNemar b=1, c=0, p=1.0;
- median Pi time 226 s off / 223 s on; p95 447 s / 442 s;
- total tokens 12.3M off / 14.6M on; cost 0.451 / 0.492;
- System One made 3–9 decisions per run with no decision failures;
- median decision latency ~0.6 s.

This is still a small pilot: the only success difference is one state-management
task, and the on arm used more tokens and cost. The registry task now completes
in both arms with the 900 s timeout. Do not treat this as evidence that System
One improves coding performance; increase repetitions and task variety.
