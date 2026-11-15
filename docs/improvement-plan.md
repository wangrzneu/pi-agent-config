# Improvement plan

Status: living document. `[x]` done, `[ ]` planned.

This document records the review findings and the agreed follow-up work for
`pi-agent-config`. It is reference material, not part of the default model
context.

## Completed

- [x] `extensions/system-one` client uses `ctx.modelRegistry.classify()` instead
      of a private HTTP client.
      - `choice` maps to Pi `choice`; `noul` maps to Pi `bool`.
      - String state maps to `{ "text": "<bounded state>" }`.
      - Provider auth, endpoint, retries, and usage/cost accounting belong to Pi.
      - `/system-one status` reports `Provider` and `Model`, not an endpoint.
- [x] New System One configuration:
      - `PI_SYSTEM_ONE_ENABLED=0|1`
      - `PI_SYSTEM_ONE_PROVIDER` (default `typesafe`)
      - `PI_SYSTEM_ONE_MODEL` (default `jev-latest`)
      - `TYPESAFE_DEFAULT_MODEL` remains a compatibility alias
      - `TYPESAFE_BASE_URL` is no longer read
- [x] Calibration uses `createAgentSessionServices()` and Pi's model runtime.
- [x] System One tests and docs updated.

## P0 — correctness and risk

### external-memory

- [x] Recall sessions that have archives but no checkpoint. Fall back to
      archive discovery when no checkpoints exist, or create a synthetic
      checkpoint during capture.
- [x] Deactivate `memory_recall` after `/memory off`. Register it with
      `defaultActive: false` and use `pi.setActiveTools()` on enable/disable.
- [x] Use one `details` shape for enabled, disabled, and empty recall results.
- [x] Add incremental capture (for example a debounced `agent_settled` tail
      capture) so a crash does not lose the current session tail.
- [x] Update `docs/external-memory.md` status from `proposed`.

### system-one

- [x] Replace the `agent_end` + `setTimeout` completion self-check with
      `agent_before_settle` + `continue: true`.
- [x] Batch risk triage per turn instead of one request per `edit`/`write`;
      keep a queue so parallel edits are not lost.
- [x] Prevent old `[WORKFLOW]` hidden messages from accumulating. Keep only the
      newest hint or use a per-turn prompt section.
- [x] Resolve `prompts/*.md` through `pi.getCommands().sourceInfo.path` instead
      of a relative path.
- [x] Use one `details` shape for `context_select` success, disabled, and
      unavailable results.
- [x] Clarify that `/system-one off` disables all decision axes, or split the
      switch per axis.
- [x] Add decision tracing for hook, latency, confidence, and cache hits.

### plan-mode

- [x] Preserve all non-write tools. Do not reduce the active set to
      `read/bash/grep/find/ls`; that disables `sandbox_authorize_read`,
      `context_select`, `questionnaire`, and other read-only tools.
- [x] On exit, restore only the `edit`/`write` tools that were active before
      entry, while preserving tools activated during plan mode.
- [x] Persist state with `pi.appendEntry()` and restore it from
      `ctx.sessionManager.getEntries()`.
- [x] Add a keyboard shortcut, todo widget, and plan progress display.
- [x] Strengthen the bash allowlist tests (`tree -o`, `find -fprint`,
      `less -o`, `date -s`, and similar mutating flags).

### work-status

- [x] Do not block `before_agent_start` on the classifier. Render a local
      heuristic immediately and update the footer if the model result arrives.
- [x] Make the model classifier opt-in (`PI_WORK_STATUS_CLASSIFIER=0` disables
      it).
- [x] Remove the duplicate classification path or share one service with
      `system-one`.

### Documentation

- [x] Fix the `/btw` timeout mismatch: code uses 45 s per round and 120 s total,
      not a shared 30 s.
- [x] Update external-memory and sandbox document statuses.
- [x] Reconcile README wording about direct file tools and sandbox path gates.
- [ ] Confirm the release tag used by the README install example exists.

## P1 — reuse Pi primitives

- [x] Register optional tools with `defaultActive: false`:
      `memory_recall`, `sandbox_authorize_read/write`, and SSH tools.
- [ ] Use `exposure: "deferred"` + `tool_search` where a tool should be
      discoverable without being declared by default.
- [x] Group SSH and sandbox tools with `namespace`.
- [x] Add `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`) to
      SSH and sandbox tools.
- [x] Add `getArgumentCompletions` to `/md`, `/sandbox`, `/ssh-tools`,
      `/memory`, and `/system-one`.
- [x] Use `registerShortcut`, `appendEntry`, and `setWidget` in plan mode.
- [ ] Add an optional SSH remote-workspace mode using
      `createReadTool`/`createWriteTool`/`createEditTool`/`createBashTool`
      `operations` instead of separate SSH tools.
- [ ] Use Pi's in-memory session or the subagent pattern for `/btw` instead of
      a hand-written provider loop.
- [x] Add `agent_before_settle` to completion handling.
- [x] Resolve on-demand prompt paths through `pi.getCommands()`.

### P1 items intentionally deferred

- `exposure: "deferred"` + `tool_search` is deferred until the activation
  behavior is verified against the installed Pi version. The tools currently
  use `defaultActive: false` with explicit `setActiveTools`.
- The optional SSH remote-workspace mode is a separate transport design; it
  should not be mixed into the remote-ops tool model without its own tests.
- Replacing `/btw` with an SDK in-memory session changes context and model
  semantics; it needs a dedicated A/B comparison first.

## P2 — product enhancements

### sandbox

- [ ] Position it as a lightweight process sandbox, not a container/VM.
- [ ] Add a container or Gondolin fallback.
- [ ] Add Windows/WSL support or a clear unsupported-platform path.
- [ ] Implement credential masking + `tlsTerminate` + SigV4 for AWS-style CLIs.
- [x] Activate `sandbox_authorize_*` only while sandboxed.
- [ ] Consider optional session grant persistence and network autocomplete.

### SSH

- [ ] ControlMaster/ControlPersist connection reuse.
- [ ] Host completion from `~/.ssh/config`.
- [ ] Persist a job registry so jobs can be rediscovered after restart.
- [ ] ProxyJump and port forwarding.
- [x] Add namespace and annotations.

### external-memory

- [ ] Prefer an index over copying session content; use Pi's session as the
      source of truth.
- [ ] Add FTS and optional embeddings.
- [ ] Add retention, pruning, encryption/redaction, and conflict handling.
- [ ] Add search UI, paging, and provenance presentation.

### markdown-viewer

- [ ] Lazy image loading.
- [ ] Table of contents, code-block copy, regex search, case toggle.
- [ ] Remote-image policy (default off or authorization-gated).
- [ ] Support `.mdx`, plain text, and session transcripts.

### btw

- [ ] Multi-turn follow-ups.
- [ ] Streaming output.
- [ ] Model selection.
- [ ] Optional local persistence.
- [ ] Use the SDK in-memory session or subagent pattern.

### work-status

- [x] Local heuristic classification with no model request.
- [ ] Configurable labels, colors, and summary width.
- [ ] Share the `system-one` decision cache.
- [ ] Add a `/status` command.

### system-one

- [ ] High-risk tasks opt in by default; low-risk tasks stay off.
- [ ] Selective verification instead of every edit.
- [ ] Independent routing/risk/completion switches.
- [ ] Use classifier usage/cost reporting.
- [x] Add decision traces.
- [ ] Add calibration CI.

## P3 — engineering

- [x] Add GitHub Actions: macOS/Linux × Node versions, `npm test`.
- [ ] Run the skipped integration tests in conditional CI.
- [ ] Add regression tests for plan-mode allowlists, external-memory
      no-checkpoint recall, system-one completion, and sandbox tool activation.
- [ ] Add prompt metadata tests.
- [ ] Publish tags/versions used by the README.
- [x] Export system-one decision traces as JSONL for A/B analysis.

## A/B testing checklist

- [ ] Pre-register hypotheses and the primary metric (task success).
- [ ] Use paired A/B runs with randomized or ABBA order.
- [ ] Fix model, thinking level, commit, tools, prompt, and repository state.
- [ ] Use a fresh worktree and `--no-session` for each run.
- [ ] Keep `work-status` constant, or treat it as part of the treatment.
- [ ] Measure wall-clock, p50/p95 latency, turns, tool calls, tokens, cost,
      risk-escalation precision/recall, extra self-check turns, and diff size.
- [ ] Add hidden tests; do not rely only on existing repository tests.
- [ ] Use realistic, multi-turn prompts.
- [ ] Analyze with McNemar for success and paired tests for continuous metrics;
      report median, IQR, and bootstrap confidence intervals.
- [ ] Decide in advance: default on, high-risk only, opt-in, or rollback.

## Research notes

The strongest external evidence is cautious:

- *Good Judgment, Bad Advice* (arXiv 2610.24649): a Jev controller raised cost
  by 19% with an identical pass rate on Terminal-Bench 2.1.
- *TypedBench* (arXiv 2610.11392): decision-model probabilities are
  wording-sensitive and can be underconfident.
- *Beyond Ranking* (arXiv 2611.11480): Jev is overconfident on relevance.
- *SWE-VERIFIER* (arXiv 2610.30284): selective verification of fewer than 4%
  of steps improves results at ~1.09× cost.
- *The Recall Trap* (arXiv 2608.14838): higher retrieval recall can reduce
  downstream issue resolution.
- *Lost in Implicit Routing* (arXiv 2610.18522): implicit skill routing
  collapses as the library grows; explicit preselection is more reliable.
- Vibe-coding studies report latency, review burden, trust, and flow as central
  experience factors, not just final code quality.

Implication: keep System One as an opt-in guardrail and measure cost, p95
latency, and downstream success before defaulting it on.
