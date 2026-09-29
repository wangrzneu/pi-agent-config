# System One workflow routing

Opt-in integration with **System One Models** — structured, calibrated decision
models such as TypeSafe's [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

The extension is a **decision sidecar**, not an agent model. It cannot generate
text or code, so it never replaces Pi's coding model. It only resolves a small,
predefined choice before the agent starts and injects a hidden hint that points
at the matching on-demand prompt.

```
unstructured state in  →  typed probabilistic decision out
```

## What it does

On `before_agent_start`, the extension asks the decision model to classify the
task into one of the [work-status](../extensions/work-status/) intents
(`design | plan | implement | test | review | fix | explore`). Above the
configured confidence threshold it injects a hidden message such as:

```
[WORKFLOW] Detected intent: fix. Read prompts/debugging.md and follow it for this task.
```

The hint is a **behavior preference** (README design principle #2): it never
blocks tools and never widens permissions. The intent→workflow mapping lives in
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

A second decision reuses the same service. Each proposed `edit`/`write` is
triaged before it is applied (`pi.change_risk.v1`, choices
`low | medium | high`); when the change looks risky, a hidden `[RISK]` hint is
injected at the next LLM call via the `context` event. It **never blocks a
tool** — escalation is attention, not a hard constraint.

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
(`pi.completion_check.v1`, choices `verified | unverified | incomplete`).

| Decision | Policy |
|---|---|
| `verified` (confident) | Silent |
| `unverified` (confident) | One hidden `[SELF-CHECK]` pass: run verification |
| `incomplete` (confident) | One hidden `[SELF-CHECK]` pass: address the request |
| Uncertain (below threshold) | **Fail safe**: one verification pass |

The pass is delivered with `pi.sendMessage(..., { triggerTurn: true })`, deferred
past the agent loop so it never re-enters it from inside `agent_end`. It runs **at
most once per user turn** (a genuine user prompt resets the budget; the
extension-triggered pass does not emit `before_agent_start`, so it cannot loop).
Turns that changed no files are skipped entirely.

### Context selection

A `context_select` tool (registered only when System One is configured) ranks a
candidate list by relevance to a task. It uses the **`noul`** primitive to ask one
yes/no question per candidate in a single request — the "many independent,
decomposed questions" pattern — then applies a deterministic threshold + top-K
policy (`extensions/system-one/context.ts`).

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

Disabled by default. Set `TYPESAFE_API_KEY` (the SDK's own env var):

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | — | API key. Required; without it the extension is inert. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | API base URL. |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Model name or alias. |
| `PI_SYSTEM_ONE_TIMEOUT_MS` | `5000` | Per-request timeout, clamped to 100–30000. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE` | per-decision defaults | Shared minimum confidence; overrides every per-decision default below. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE_INTENT` | `0.5` | Workflow-intent threshold. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE_RISK` | `0.6` | Change-risk threshold. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE_COMPLETION` | `0.6` | Completion threshold. |
| `PI_SYSTEM_ONE_MIN_CONFIDENCE_CONTEXT` | `0.5` | Context-selection relevance threshold. |

Configuration is re-resolved on each `session_start`, so env changes take effect
on the next session without a full restart. `/system-one` toggles and inspects
routing at runtime without touching the env:

```
/system-one          # status: on/off, configured, endpoint, model
/system-one off      # stop routing this session
/system-one on       # resume routing
```

Status never prints the API key. Results are cached per prompt (128 entries) and
the request is bounded (`MAX_STATE_CHARACTERS = 6000`). Pi awaits
`before_agent_start` handlers before building the turn, so an uncached prompt
adds up to `PI_SYSTEM_ONE_TIMEOUT_MS` of latency; cached prompts add none.

## Wire contract

This is the real `POST /v1/systemone` contract from the public
[`typesafe_sdk`](https://pypi.org/project/typesafe-sdk/), not a guess. System One
Models are not chat-completion models, so they do not go through Pi's
`completeSimple` path.

```http
POST <TYPESAFE_BASE_URL>/v1/systemone
accept: application/json
content-type: application/json
authorization: Bearer <TYPESAFE_API_KEY>

{ "model": "jev-latest",
  "state": "<task prompt / diff, truncated to 6000 chars>",
  "questions": {
    "pi.workflow_intent.v1": {
      "type": "choice",
      "instructions": "Classify the developer's current task by its dominant intent.",
      "criteria": { "design": "...", "plan": "...", "fix": "...", "...": "..." }
    }
  } }
```

The API supports three primitives — `noul` (yes/no), `choice`, and `score`
(rubric). Two are wired: `choice` (a calibrated `confidence`) for the three
decisions, and `noul` (a probability) for context ranking, which asks one question
per candidate in a single request. `score` is unused.

```json
{ "answers": {
    "candidate_0": { "type": "noul", "noul": 0.94 },
    "candidate_1": { "type": "noul", "noul": 0.12 } } }
```

```json
{ "model": "jev-latest",
  "usage": { "input_tokens": 448, "output_tokens": 55 },
  "answers": {
    "pi.workflow_intent.v1": {
      "type": "choice",
      "choice": "fix",
      "confidence": 0.87,
      "probabilities": { "fix": 0.87, "review": 0.11, "...": 0.0 }
    }
  } }
```

The client requires `answers[<question id>]` to be a `choice` answer, with
`choice` one of the requested criteria labels and `confidence` a number in
`[0, 1]`. Anything else is rejected (fail-open). A full error response, a
missing answer, an unexpected `type`, or an off-schema label all yield
`undefined`.

### Calibration

Thresholds are decision-specific and should be calibrated against your own data:

```bash
TYPESAFE_API_KEY=... npm run calibrate
```

The runner sends labeled fixtures (`extensions/system-one/calibration.ts`) for
all three decisions, then prints per-decision accuracy, **confidence buckets**
(does higher confidence mean higher accuracy?), the lowest threshold whose
confident decisions meet a target accuracy, and ready-to-paste exports:

```bash
export PI_SYSTEM_ONE_MIN_CONFIDENCE_INTENT=0.6
export PI_SYSTEM_ONE_MIN_CONFIDENCE_RISK=0.8
export PI_SYSTEM_ONE_MIN_CONFIDENCE_COMPLETION=0.7
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

- extension not configured (`TYPESAFE_API_KEY` unset) or `/system-one off`;
- empty state;
- transport error, non-2xx response, malformed JSON;
- off-schema `choice` or out-of-range confidence;
- request timeout (merged with the caller's abort signal).

This is separate from the *policy* on a decision that did arrive: routing fails
open (a low-confidence answer does nothing), while change-risk and completion
fail safe (a low-confidence answer escalates). An unavailable model never
blocks or degrades an agent turn. To disable the feature, run
`/system-one off`, unset `TYPESAFE_API_KEY`, or remove the extension.

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

## Testing

```bash
node --experimental-strip-types --test extensions/system-one/*.test.mjs
```

Tests inject a service (`createWorkflowService({ getClient })`) and a fake
`fetch`, so they never touch the network.
