# [Draft issue] Extension API: let event handlers trigger a "resample" — re-run the current turn with the same prefix

> Target: `@earendil-works/pi-coding-agent` (pi). This is a draft for upstream; it documents an API gap found while building an agent-loop guard (see `docs/agent-loop-handling.md`).

## Summary

An extension that watches an in-flight agent turn (via `tool_call` / `message_update` events) cannot currently make pi **discard the current (poisoned) turn and re-run it with the same input prefix** — the "resample" behavior that Grok Build's doom-loop recovery implements at its sampler layer. The three primitives needed for a message-layer resample all exist:

1. `ctx.abort()` — stop the current run (**event ctx** ✓),
2. `tool_call` → `{ block: true }` — prevent poisoned tool calls from producing toolResult side effects (**event ctx** ✓),
3. `context` event → return `{ messages }` — drop the poisoned turn from the next LLM call's view (**event ctx** ✓),

…but the fourth primitive — re-trigger a turn with the same prefix — is `ctx.sendUserMessage()`, which is **only available on `ExtensionCommandContext`** (command/shortcut handlers), not on the `ExtensionContext` that event handlers receive. There is also no way to programmatically invoke a command handler from an event handler. The chain therefore cannot be closed from the event layer where the loop is detected.

## Current API surface (verified)

| Method | `ExtensionContext` (events) | `ExtensionCommandContext` (commands/shortcuts) |
| --- | --- | --- |
| `abort()` | ✓ | ✓ |
| `signal` | ✓ | ✓ |
| `sendUserMessage(content, { deliverAs: "steer" \| "followUp" })` | **✗** | ✓ |
| `sendMessage(…, { triggerTurn, deliverAs: "steer"\|"followUp"\|"nextTurn" })` | **✗** | ✓ |
| `waitForIdle()` | ✗ | ✓ |

- `ExtensionContext` (`dist/core/extensions/types.d.ts:209`) — event handlers get this.
- `ExtensionCommandContext extends ExtensionContext` (`:254`) — adds session-control methods, incl. `sendUserMessage` (`:915-921`).
- Docs (`extensions.md`, "ExtensionCommandContext"): "These are only available in commands because **they can deadlock if called from event handlers**."

## Use case (why this matters)

`extensions/loop-guard` detects a stuck agent loop by watching `tool_call` repetition and/or repeated output phrases (`message_update`). Today it either prompts the user (TUI) or `abort()`s (headless). Grok Build (open source, `xai-org/grok-build`) instead does a **silent resample**: on a confident "doom loop" signal, discard the poisoned turn and re-issue the exact same request prefix, up to a retry budget, then accept as-is. This is invisible to the user and strictly better UX than an interrupt prompt.

pi can reproduce that at the message layer (no provider wrapping needed) *if* an event handler can push a fresh turn:

```
confident loop (tool_call / message_update)
  → tool_call block (no toolResult side effects)
  → ctx.abort()
  → [need] re-trigger the same prefix as a new turn
  → context event filters the aborted assistant output out of the next LLM call
  → repeat up to budget; exhausted → accept
```

The only missing hop is "re-trigger a turn from an event handler."

## Proposed API (options, in preference order)

**Option 1 (recommended): `sendUserMessage` with a deferred delivery mode on `ExtensionContext`.**

Add a delivery semantic that avoids the documented re-entrancy/deadlock: when called from an event handler (or with `{ deliverAs: "nextTurn" }`), pi **queues** the message and dispatches it only after the current agent run settles (same as `followUp`, but gated on "idle" rather than "streaming"), so it never re-enters the run that is currently emitting the event.

```ts
// event handler
ctx.sendUserMessage(originalPrefix, { deliverAs: "nextTurn" });
```

Rationale for queueing (not direct dispatch): the docs explicitly warn command-context methods "can deadlock if called from event handlers"; queueing sidesteps re-entrancy while preserving the "always triggers a turn" contract.

**Option 2: first-class retry/resample primitive at the agent level.**

`agent.rerunCurrentTurn({ id })` / an `agent_end`-adjacent result such as `{ rerun: true }` on `message_end` — stop the turn, discard its in-flight output and any blocked tool calls, and re-issue with the same messages. Closest to Grok's sampler semantics; more invasive in the run loop.

**Option 3 (least preferred): `ctx.invokeCommand(name, args)` bridge.**

Programmatically run a registered command handler. Simple but exposes the whole command surface to events for one use case; risks encouraging re-entrancy.

## Acceptance criteria (for the recommended option)

- [ ] An extension can call `sendUserMessage` from `tool_call`/`message_update`/`message_end`/`agent_end` handlers without deadlock or re-entrancy.
- [ ] With `deliverAs: "nextTurn"`, the message is dispatched only after the current run reaches idle (`ctx.isIdle()` true), never mid-stream.
- [ ] `input` event observes the injected turn with `source: "extension"` (existing contract, `extensions.md` line 898) so extensions can route/skip it.
- [ ] `context` event still fires for the resampled run and can filter messages (existing behavior, unchanged).
- [ ] Headless/print/RPC modes behave the same as TUI (no dependency on `ui.confirm`).
- [ ] Budget semantics can be expressed by the extension (e.g., count `tool_call`-repeat detections; after N resamples, stop).

## Alternatives considered (and why they fall short)

- **Provider wrapping** (`registerProvider(name, { streamSimple: wrapped })`): true sampler-level resample, but wraps *every* request for the provider and must re-implement every provider's stream-shape handling — disproportionate for a guard extension, and it conflicts with the docs' "provider override" mental model.
- **`before_provider_request` payload replacement**: fires only before a *fresh* request; cannot re-issue a finished one.
- **`message_end` message replacement**: can only replace the finalized message (same role); cannot remove preceding turn messages or their toolResults.
- **Do nothing / keep interrupt prompt**: loop-guard keeps its user-facing prompt; workable but worse UX than silent resample, and headless mode still hard-aborts.

## Notes / risks

- Re-entrancy is the documented reason for the current restriction; the queueing design must be reviewed against `runner.js` event dispatch (events are awaited sequentially per handler; a queued dispatch avoids calling into `agent-session` while it is mid-event-loop).
- `sendUserMessage` currently supports only `"steer" | "followUp"`; adding `"nextTurn"` (already present on `sendMessage`) is a small, consistent extension.
- Backwards compatible: the new method is additive on `ExtensionContext`; no existing behavior changes.

## Related

- This repo's research: `docs/agent-loop-handling.md` (how Grok Build / Claude Code / Codex / AutoGen handle loops).
- `extensions/loop-guard` (the extension that motivates this).

---

## 上游 issue 调研结论（2026-08 补充，含接收状态核实）

抓取 `earendil-works/pi` 的 issue 追踪器并核实每个条目的**真实接收状态**（state / state_reason / PR merged_at）后，结论与初版判断相反：**这些相关 issue 一个都没有被接受**。

### 核实结果（以 GitHub 状态为准，2026-08）

| # | 标题 | 状态 | 是否被接受 |
| --- | --- | --- | --- |
| **#7277** | Enable extensions to run registered extension commands after the agent settles | closed `not_planned` + `no-action`（2026-07-29） | ❌ **拒绝** |
| **#7293** | fix(coding-agent): queue extension commands after agent runs（`pi.queueCommand` 提案） | closed 但 **`merged: false`**（2026-07-30） | ❌ **未合并**（PR 关闭未合） |
| **#7484** | Extension-sent slash commands never execute（sendUserMessage skips command handlers） | closed `not_planned` + `no-action`（2026-08-02） | ❌ **拒绝** |
| **#7345** | Expose extension user-message submission outcome（`pi.submitUserMessage` Promise） | closed `not_planned` + `no-action`（2026-07-30） | ❌ **拒绝** |
| **#5998** | Adding `terminate` hint for blocked tool calls（原始 issue） | open `reopened` | 🔄 进行中 |
| **#7715** | feat(agent): allow blocked tool calls to terminate（PR） | open，`mergeable: true` | 🔄 待合（未合） |

> **教训记录**：初版调研把“closed”误读为“已接受”。GitHub 的判断依据应是：`state_reason: not_planned` + `no-action` 标签 = 拒绝；closed 的 PR 要看 `merged` 字段。三处被拒（#7277/#7484/#7345）与此方向一致：上游暂时不接受“事件层触发命令/用户消息”这类 API 面扩展。

### 现在的实际状态

- **不存在**任何被接受的“事件 handler → 命令/用户消息”桥（#7293 未合、#7277/#7345 被拒）。
- `terminate` hint（#5998/#7715）是唯一还活着的相关路径，且仍未合并。
- 因此本文件正文的提案（Option 1/2/3）**当前都无法靠上游已接受 API 实现**；“provider 包装”仍是唯一今天可落地同前缀重采样的途径（代价见正文 Alternatives）。

### 结论与后续行动

1. **不要在“已接受”的假设上等上游**：至少 #7277/#7345 已明确 no-action，重提需新论证（例如把“重采样”包装成通用“turn 重试”原语，而不是扩展消息注入）。
2. 可关注 #7715（terminate hint）：它即使合入也只解决“blocked tool call 干净终止”，不解决“重发同前缀”，不改变结论。
3. 若要在今天实现同前缀重采样：**只能走 provider 包装**（正文 Option A），或继续用已落地的 B 方案（静默 abort + 冷却，`docs/agent-loop-handling.md`）。
4. 本文件正文若最终要发上游 issue，建议改为**平台原语提案**（agent 层 `rerunTurn`/重试语义），而非扩展层 `sendUserMessage`——后者已被上游两次拒绝。
