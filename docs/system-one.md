# System One decisions

Opt-in integration with **System One Models** — structured, calibrated decision
models such as TypeSafe's [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

The extension is a **decision sidecar**, not an agent model. It cannot generate
text or code, so it never replaces Pi's coding model. It resolves small,
predefined decisions and turns them into hidden hints or one extra step.

```
unstructured state in  →  typed probabilistic decision out
```

| Capability | Trigger | Primitive | Policy | Effect |
|---|---|---|---|---|
| Workflow routing | `before_agent_start` | `choice` | fail-open | hidden `[WORKFLOW]` hint → on-demand prompt |
| Change-risk triage | after `edit` / `write` | `choice` | fail-safe | hidden `[RISK]` hint before the next call |
| Completion self-check | `agent_before_settle` (files changed) | `choice` | fail-safe | one extra verification pass (≤ once per user turn) |
| Context selection | `context_select` tool | `noul` → Pi `bool` | threshold + top-K | ranks candidate files by relevance |

## What it does

On `before_agent_start`, the extension asks the decision model to classify the
task into one of the [work-status](../extensions/work-status/) intents
(`design | plan | implement | test | review | fix | explore`). Above the
configured confidence threshold it injects a hidden message such as:

```
[WORKFLOW] Detected intent: fix. Read prompts/debugging.md and follow it for this task.
```

The hint is a **behavior preference** (README design principle #2): it never
blocks tools and never widens permissions. Only the newest workflow hint is
kept in context, so a long session does not accumulate stale intent messages. The intent→workflow mapping lives in
`extensions/system-one/routing.ts` and is pure and deterministic.

| Intent | Prompt | Suggests planning |
|---|---|---|
| `design` | `prompts/architecture.md` | yes |
| `plan` | — | yes |
| `review` | `prompts/review-first.md` | no |
| `fix` | `prompts/debugging.md` | no |
| `implement` / `test` / `explore` | — | no |

### Shared decision with work-status

The decision is resolved by a process-wide service
(`extensions/system-one/service.ts`): one client and one per-prompt cache.
`work-status` calls the same service for the footer, so a prompt is decided **at
most once per session** regardless of how many consumers ask. Because System One
Models return structured values (no generated text), the footer summary is
derived deterministically from the prompt with `summarizeWork`. When System One
is off or unconfigured, `work-status` falls back to its existing model
classifier — so there is still exactly one request per turn either way.

### Change-risk triage

A second decision reuses the same service. Proposed `edit`/`write` calls are
queued and triaged once per model request (`pi.change_risk.v1`, choices
`low | medium | high`); parallel edits are combined rather than overwriting each
other. When the change looks risky, a hidden `[RISK]` hint is injected at the
next LLM call via the `context` event. It **never blocks a tool** — escalation
is attention, not a hard constraint.

| Decision | Policy |
|---|---|
| `high` (confident) | Escalate: inspect, run tests, follow `prompts/review-first.md` |
| `medium` (confident) | Escalate: consider `prompts/review-first.md` |
| `low` (confident) | Silent |
| Uncertain (below threshold) | **Fail safe**: treated as medium |

This axis is deliberately **fail-safe**, unlike routing (which fails open by
doing nothing): a low-confidence assessment escalates rather than staying
silent. `assessChangeRisk` returning `undefined` (off/unconfigured) still does
nothing.

### Completion self-check

A third decision guards the end of a turn. When a turn changed files, the
extension asks whether the request is actually satisfied and verified
(`pi.completion_check.v1`, choices `verified | unverified | incomplete`). It
uses Pi's `agent_before_settle` boundary and returns one `custom_message` draft
with `continue: true`, instead of scheduling a turn from `agent_end`.

| Decision | Policy |
|---|---|
| `verified` (confident) | Silent |
| `unverified` (confident) | One hidden `[SELF-CHECK]` pass: run verification |
| `incomplete` (confident) | One hidden `[SELF-CHECK]` pass: address the request |
| Uncertain (below threshold) | **Fail safe**: one verification pass |

The pass is delivered as one `custom_message` draft from
`agent_before_settle`. It runs **at most once per user turn**: a genuine user
prompt resets the budget, while the extension-triggered pass has
`messageType: "custom"` and does not reset it.
Turns that changed no files are skipped entirely.

### Context selection

A `context_select` tool (registered only when System One is configured) ranks a
candidate list by relevance to a task. It maps the extension's **`noul`** question
to Pi's `bool` primitive: one yes/no question per candidate in a single request —
the "many independent, decomposed questions" pattern — then applies a
deterministic threshold + top-K policy (`extensions/system-one/context.ts`).

```
context_select(task: "add login", candidates: ["src/auth.ts", "src/ui/button.tsx", ...])
-> Most relevant candidates (probability):
   - src/auth.ts (0.94)
   - src/session.ts (0.81)
```

- Candidates are deduped and capped at `MAX_CONTEXT_CANDIDATES = 200`. Each path is
  sanitized and capped at `MAX_CANDIDATE_LENGTH = 200`, and any candidates that
  would push the assembled state past `MAX_CONTEXT_CHARACTERS` are dropped.
- Candidate paths go in `state` — the field the API treats as **untrusted** — while
  each question refers to a candidate by index (`candidate_3`). A hostile filename
  therefore cannot inject instructions into the question channel.
- The model must answer **every** question; a partial response is rejected so
  missing candidates are never silently scored as 0.
- The threshold defaults to `PI_SYSTEM_ONE_MIN_CONFIDENCE_CONTEXT` (0.5);
  `max_results` defaults to 25.
- It only **ranks** — it never reads files or changes what the agent may access.
  The agent still decides what to read.

## Enabling

Disabled by default. `TYPESAFE_API_KEY` is the convenience opt-in for the
`typesafe` provider; `PI_SYSTEM_ONE_ENABLED=1` enables the extension for a
classifier that Pi already knows about (for example through `/login` or
`models.json`).

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Convenience opt-in for the `typesafe` provider. Without it, set `PI_SYSTEM_ONE_ENABLED=1` for a provider configured in Pi. |
| `PI_SYSTEM_ONE_ENABLED` | — | `0` disables; `1` enables without requiring `TYPESAFE_API_KEY`. |
| `PI_SYSTEM_ONE_PROVIDER` | `typesafe` | Pi classifier provider. |
| `PI_SYSTEM_ONE_MODEL` | `jev-latest` | Classifier model id. `TYPESAFE_DEFAULT_MODEL` is a backward-compatible alias. |
| `PI_SYSTEM_ONE_TIMEOUT_MS` | `5000` | Per-request timeout, clamped to 100–30000. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE` | per-decision defaults | Shared minimum confidence; overrides every per-decision default below. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE_INTENT` | `0.5` | Workflow-intent threshold. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE_RISK` | `0.6` | Change-risk threshold. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE_COMPLETION` | `0.6` | Completion threshold. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE_CONTEXT` | `0.5` | Context-selection relevance threshold. |
| `PI_SYSTEM_ONE_TRACE` | — | Optional JSONL path for decision latency/cache/confidence traces. |

The endpoint, credentials, and request format belong to Pi's model registry.
To use a custom endpoint, configure the selected provider in `models.json`;
`TYPESAFE_BASE_URL` is no longer read by this extension.

Configuration is re-resolved on each `session_start`, so env changes take effect
on the next session without a full restart. `/system-one` toggles and inspects
all decision axes at runtime without touching the env:

```
/system-one          # status: on/off, configured, provider, model
/system-one off      # stop routing, risk, completion, and context decisions
/system-one on       # resume all decisions
```

Status never prints credentials. Results are cached per prompt (128 entries) and
the request is bounded (`MAX_STATE_CHARACTERS = 6000`). Set
`PI_SYSTEM_ONE_TRACE` to a file path to record JSONL traces with hook kind,
latency, cache status, confidence, and success; tracing is best-effort and never
changes a decision. Pi awaits
`before_agent_start` handlers before building the turn, so an uncached prompt
adds up to `PI_SYSTEM_ONE_TIMEOUT_MS` of latency; cached prompts add none.

## Classifier request mapping

The extension does not call the HTTP API directly. It asks Pi's model registry
for the configured classifier and lets Pi resolve authentication, the endpoint,
retries, and usage/cost accounting:

```ts
const model = ctx.modelRegistry.getModelOfType(
  "classifier",
  config.provider,
  config.model,
);
const result = await ctx.modelRegistry.classify(model, {
  state: { text: boundedState },
  questions: {
    "pi.workflow_intent.v1": {
      type: "choice",
      instructions: "Classify the developer's current task by its dominant intent.",
      criteria: { design: "...", plan: "...", fix: "..." },
    },
  },
}, { signal });
```

Pi's classifier API supports three primitives — `bool` (yes/no), `choice`, and
`score` (rubric). This extension maps its two decision types as follows:

- `choice` → Pi `choice` (a calibrated `confidence` and optional probabilities).
- `noul` → Pi `bool` (a probability; both criterion labels are required, so
  missing labels get neutral defaults).
- The extension's string state → `{ "text": "<bounded state>" }` because Pi's
  classifier state must be a JSON object.

Context ranking asks one `bool` question per candidate in a single request.
`score` is unused.

The client requires `result.stopReason === "stop"`, a `choice` that is one of the
requested criteria labels, and confidence/probabilities in `[0, 1]`. A `noul`
assessment requires every requested question to be answered as a valid `bool`.
Anything else is rejected (fail-open). A missing model, an error or aborted
result, a missing answer, an unexpected `type`, or an off-schema label all yield
`undefined`.

### Calibration

Thresholds are decision-specific and should be calibrated against your own data:

```bash
npm run calibrate
# or, for the `typesafe` provider:
TYPESAFE_API_KEY=... npm run calibrate
```

The runner uses Pi's model runtime, so it can also use credentials already stored
by Pi (for example `/login` or `models.json`). It sends labeled fixtures
(`extensions/system-one/calibration.ts`) for all three decisions, then prints
per-decision accuracy, **confidence buckets** (does higher confidence mean higher
accuracy?), the lowest threshold whose confident decisions meet a target
accuracy, and ready-to-paste exports:

```bash
# example output (this run adopted 0.5 / 0.6 / 0.6)
export PI_SYSTEM_ONE_MIN_CONFIDENCE_INTENT=0.5
export PI_SYSTEM_ONE_MIN_CONFIDENCE_RISK=0.6
export PI_SYSTEM_ONE_MIN_CONFIDENCE_COMPLETION=0.6
```

Thresholds are per decision, so each recommendation maps directly to one
variable. Override the accuracy target with `PI_SYSTEM_ONE_CALIBRATION_TARGET`
(default `0.9`).

### Calibration results (jev-latest, 45 fixtures)

| Decision | Accuracy | Confidence | Threshold |
|---|---|---|---|
| `intent` | 15/15 | one at 0.50, rest ≥ 0.8 | `0.5` |
| `risk` | 12/15 | misses at 0.54 / 0.73 / 0.19 | `0.6` |
| `completion` | 15/15 | every bucket 100% | `0.6` |

**intent** is clean; the one sub-0.6 answer (`refactor…`) is still correct.

**risk**: the misses are `src/util/format.ts` (0.55), `src/db/users.ts` (0.20) and
`package.json` (0.73). The first two fall *below* the 0.6 threshold, so the
fail-safe policy escalates them to a review pass anyway. Only the confident
`package.json` miss — a React `^17 → ^18` major bump, answered `medium` — is a real
disagreement, and the fixture stays `high` deliberately.

**completion**: tightening `criteria.verified` (from "there is evidence" to "a
reported test/build/lint result") plus relabelling the `grep shows no remaining
references` case as `unverified` took completion from 11/15 to **15/15**. Every
`verified` answer now reports a build/test result, and the grep case is correctly
`unverified` (0.78). Because an `unverified` answer escalates at *any* confidence,
the completion **threshold is not the lever — the definition of "verified" is**.

#### Label conventions

- **intent** — the *dominant* intent, not keywords: test-after-fix → `test`.
- **risk** — `high` for auth / money / concurrency / persistence / public
  contracts / major dependency bumps; `medium` for shared-util behavior changes
  and query-semantics changes; `low` for docs, styling, and test-only edits.
- **completion** — `verified` requires a reported **test/build/lint** result;
  merely describing the change, or a grep/search, is `unverified`; a partially met
  multi-part request is `incomplete`.

The runner prints every case (`ok` / `MISS` + label + answer + confidence) so a
miss traces back to its fixture. Thresholds are only as good as the labels. Re-run
`npm run calibrate` after changing criteria or fixtures.

## Fail-open by design

When the model is *unavailable*, every decision returns `undefined` and the
caller does nothing:

- extension not configured (missing classifier model, no opt-in, or unavailable provider) or `/system-one off`;
- empty state;
- classifier result error or abortion;
- off-schema `choice` or out-of-range confidence/probability;
- request timeout (merged with the caller's abort signal).

This is separate from the *policy* on a decision that did arrive: routing fails
open (a low-confidence answer does nothing), while change-risk and completion
fail safe (a low-confidence answer escalates). An unavailable model never blocks
a tool or widens permissions, but an uncached routing/risk/completion decision
can add up to `PI_SYSTEM_ONE_TIMEOUT_MS` of latency at its hook. To disable the
feature, run `/system-one off`, disable the classifier provider, or remove the
extension.

## Boundaries (what this must not do)

- **Never** use a probabilistic model to authorize sandbox, plan-mode, or SSH
  access. Those stay deterministic and fail-closed (see `docs/security.md`).
  A decision model may at most *escalate* to human confirmation, never widen
  permissions.
- **Never** let it write session state, memory evidence, or files. It only
  ranks/chooses; provenance stays deterministic.
- `context_select` only *ranks* candidates; it never reads files or widens access.
- `work-status` reuses this same decision (`extensions/system-one/service.ts`),
  so a prompt is decided once per session instead of once per consumer. When
  disabled or unconfigured, `work-status` falls back to its own model classifier.

## Known risks and limitations

**Correctness / calibration**

- **Context selection is uncalibrated.** `PI_SYSTEM_ONE_MIN_CONFIDENCE_CONTEXT`
  (0.5) is a default; `npm run calibrate` covers only the three `choice`
  decisions. Ranking quality needs task+candidate fixtures and a precision@k
  metric.
- **Fixtures are synthetic** (45 cases, one model). The risk fixture for a React
  `^17 → ^18` bump is a known disagreement — labelled `high`, answered `medium`.
- **Thresholds are model-specific.** Switching models (e.g. `jev-preview`)
  requires re-running `npm run calibrate`.

**Privacy / dependency**

- **Data leaves the machine.** Task prompts, `edit` diffs, the last request plus
  assistant replies (completion), and candidate paths are sent to the endpoint
  configured for the selected classifier provider in Pi. Treat that endpoint as
  untrusted for sensitive code: configure a self-hosted provider in `models.json`,
  or run `/system-one off`.
- **Classifier API dependency.** The extension now uses Pi's classifier registry;
  an upstream change to the `bool`/`choice` contract or the provider catalog is
  handled by Pi, but may still require updating this extension's mapping or
  selected model.

**Behavioural side effects**

- **Completion can add one turn** (at most once per user prompt); a miscalibrated
  model produces unnecessary passes.
- **The `work-status` footer summary becomes a deterministic truncation** while
  System One is on, because Jev returns no generated text.
- **Context selection is a tool, not automatic**, so its benefit depends on the
  agent calling it.
- **Latency**: routing / risk / completion await a decision at their hook (cached
  per prompt); context is on demand.

## Testing

```bash
node --experimental-strip-types --test extensions/system-one/*.test.mjs
```

Tests inject a service (`createWorkflowService({ getClient })`) and a fake
`fetch`, so they never touch the network.
