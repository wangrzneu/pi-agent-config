# 类似 Agent 如何应对"循环/重复打断"(loop & stuck-agent 处理调研)

> 背景：`extensions/loop-guard` 通过检测"重复工具调用/重复输出短语"来打断卡死的 agent,但存在误判。为优化它,调研了主流同类 Agent 的实际做法。本文全部基于一级来源(开源代码 + 官方 changelog)。

## 来源

| Agent | 来源 | 说明 |
| --- | --- | --- |
| **Grok Build** (xAI) | `xai-org/grok-build` 开源 Rust 源码 | `xai-grok-sampling-types/src/doom_loop.rs`、`xai-grok-sampler/src/doom_loop.rs`、`tests/test_doom_loop_recovery.rs` 等 |
| **Claude Code** (Anthropic) | 本地 cli.js v2.0.42 + CHANGELOG v2.1.223 | 循环处理靠预算/约束,无句法级循环检测 |
| **OpenAI Codex** | `openai/codex` (codex-rs) | `core/src/tasks/lifecycle.rs` 等,无循环检测器 |
| **Qwen Code** | `QwenLM/qwen-code` issue #4055 | loop-guard 引用的原始问题:模型思考循环 10-15 分钟不答复 |
| **AutoGen** (Microsoft) | `autogen-agentchat` 官方源码 | 声明式终止条件(termination conditions) |

---

## 1. 现状对比:核心分歧在于"谁来判"

| Agent | 检测位置 | 检测内容 | 触发后动作 | 误判防护 |
| --- | --- | --- | --- | --- |
| **Grok Build** | **服务端**(inference API,`x-grok-doom-loop-check` 头) | 模型**思考流**(非输出)的 **tail repetition**(尾部重复) + low-logprob | 客户端**重采样**(discard poisoned turn,同前缀重发一次)| 阈值可配;只在**思考流**、只在"紧致"重复(`tail_repetition:N@thinking`, N≤8);`low_logprob` 仅告警;预算耗尽则接受最后响应 |
| **Claude Code** | 无句法检测 | — | — | 用**资源预算**防"失控扩张"而非"重复检测" |
| **OpenAI Codex** | 无内置检测 | — | 通过 lifecycle 事件(start/stop/idle/abort)交给扩展/用户 | 依赖用户/外部 |
| **AutoGen** | **用户声明式**终止条件 | max_turns、token 用量、文本提及、外部终止 | 由 API 显式定义停止 | 检测完全由调用者定义,框架不自动判 |

关键点:**只有 xAI 把"重复检测"做进了产品,而且放在服务端+仅针对思考流**。其余的产品(Claude Code/Codex)都**不做句法级循环检测**,而是用"预算/约束"或"交给用户"来处理。

---

## 2. xAI Grok Build 的 doom-loop 机制(最接近 loop-guard 的做法)

### 2.1 服务端检测(wire 协议)

- 客户端通过请求头 `x-grok-doom-loop-check` 选择启用。
- 服务端在流式 `/v1/responses` 里检测生成循环,通过两类通道上报:
  - **mid-stream SSE 事件** `response.doom_loop_check`,携带**累积**触发集;
  - 终态响应对象上的 `doom_loop_check: {"triggers": [...]}` 字段。
- 触发标签语法:`tail_repetition:{threshold}@{channel}` 或 `low_logprob@{channel}`。
- **channel 只有两个:thinking 和 response**。恢复逻辑**只对 thinking 通道行动**——"可见输出里的循环交给用户判断"(types.rs 注释原文)。

### 2.2 客户端恢复(resample)

- `DoomLoopRecoveryPolicy` 默认:`max_threshold=8`(只对 `tail_repetition:N@thinking` 且 N≤8 行动,更低阈值=更紧更确信的循环)、`max_retries=2`。
- 出现"确信"触发 → **放弃整个毒化 turn 的输出**(不进入对话历史),**用相同前缀重采样**(request body 与第一次一致)。
- **预算耗尽** → 接受最后一个响应(即使仍被判循环),保证 turn 仍成功——绝不无限重试。
- 解析全容忍(malformed payload → 只记录/吞掉,绝不让流失败)——"feature 永远不能让一条流挂掉"。

### 2.3 值得抄的设计点

1. **只在"无进展"通道上检测**:思考流重复是强信号,可见输出重复可能是"用户需要看的"——所以默认不拦输出重复。loop-guard 目前把 text 和 thinking 混在一起喂同一个检测器,这是误判源之一。
2. **保守的阈值**:服务端报告的是"尾部重复 N 次 @ 通道",客户端只在 **thinking && N≤8** 才行动。loop-guard 的 `minPhraseLength=4`+`maxRepeatedPhrases=6` 相比宽松得多。
3. **恢复=重采样而非打断**:检测到循环后,丢弃坏 turn、重发一次,而不是停下来问用户——**对用户完全无感**。loop-guard 是"弹窗打断",体验完全不同。
4. **预算耗尽即接受 + 最多重试**:绝不无限循环,即使检测器失灵。
5. **能力边界**:`low_logprob`(低概率=模型胡言乱语)只告警不行动。

---

## 3. Claude Code:用"预算"和"约束"而非检测

v2.0.42 cli.js 中**没有**任何 doom-loop / 重复检测代码。其应对循环的方式:

- **资源级预算**(2.1.x changelog 原文):
  - `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`(默认 200)— "to stop runaway search loops"
  - `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`(默认 200)— "to stop runaway delegation loops"
  - `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`(默认 20)— 防一条消息扇出无界后台 agent
  - `--max-budget-usd` — 预算上限到达后拒绝新 spawn 并中止运行中后台 agent
  - 修复了大量"重试循环":context-overflow 后重发相同 doomed 请求、后台 agent 崩溃循环、`/loop` 命令等。
- **上下文压缩(auto-compact)**:token 窗口管理,而非循环检测。
- **交互式中断**:`Esc`/`/loop` 由用户控制。

**哲学**:这些产品**不试图自动判"这是循环"**,而是**限制失控扩张的资源**(搜索次数、子 agent 数、token、美元),靠用户或预算停。误判率天然为零,但会漏掉"资源没超限但在原地打转"的循环。

---

## 4. OpenAI Codex、AutoGen、Qwen

- **Codex-rs**:`tasks/lifecycle.rs` 只有 lifecycle 事件(start/stop/idle/abort)的发射,循环处理**委托给扩展 contributor 和用户控件**,无内置检测。
- **AutoGen**:声明式 **TerminationCondition**(`max_turns`、`TokenUsageTermination`、`TextMentionTermination`、`ExternalTermination`),由调用者显式定义"何时停",框架不做自动循环判断。
- **Qwen Code issue #4055**(loop-guard 的起点):用户让 qwen-code 改文档,模型"思考循环 15 分钟不答复"。**值得注意的是:用户抱怨的是"不答复"(没有产出),而不是"重复相同调用"** —— 这是"无进展",loop-guard 的 `maxTotalCalls`/输出检测正是朝这个方向,但触发条件过松。

---

## 5. 对 loop-guard 优化的启示(直接输入)

| 调研发现 | 启示 |
| --- | --- |
| Grok 只检测 **thinking 通道** | loop-guard 应把 text_delta 与 thinking_delta **分开**,或默认只对 thinking 检测重复;对可见输出重复用更高阈值 |
| Grok 用**紧致阈值**(N≤8 尾部重复)才行动 | 提高 `minPhraseLength`(4→8+)并过滤无意义短语,降低误判 |
| Grok **重采样**而非打断 | "打断一次"比"默默重试"更打扰用户——保持打断的前提是有更高置信度 |
| Grok **预算耗尽即接受** | "一次打断被否 → 整个 run 静默"其实好过反复横跳;但若用户拒绝了,说明误判——可考虑**会话级自适应**(本次 run 已误判 → 后续调高阈值) |
| Claude 用**资源预算** | 保留 `maxTotalCalls` 但**补充"无进展"信号**(有输出/输入变化则重置计数器),且给总量设更高的默认值 |
| Claude 的 /loop、AutoGen 的声明式 | loop-guard 已有 `/loop-guard off|on|reset`,可补充"本次 run 内只触发一次"的同时静默降级而非完全停用 |

**一句话**:主流做法共识是——**"无进展"优先于"句法重复"**;检测要保守(高阈值、长短语、分通道),宁可漏报不可误报;触发后的动作要么无感重试(服务端),要么交给用户(预算/弹窗),但绝不能在用户已明确"继续"后再反复打断。

---

## 5. 可行性：pi 上能否做到「同前缀重采样」而*不*包装 provider？

结论：**三个原语都存在，但事件处理层缺一个中转，当前无法纯靠事件 handler 串起来 —— 需要一个小平台补丁或选 provider 包装。**

### 已确认可用的原语（pi 扩展 API，一级来源）

| 能力 | 出处 | 说明 |
| --- | --- | --- |
| `ctx.abort()` | `ExtensionContext` | 终止当前 run（Grok 的“丢弃毒化 turn”第一步） |
| `ctx.sendUserMessage(content, {deliverAs})` | **仅 `ExtensionCommandContext`**（命令/快捷键 handler） | “Always triggers a turn”——可重发同一前缀 |
| `context` 事件返回 `{ messages }` | `pi.on("context")`，每次 LLM 调用前触发 | 深拷贝 messages，可过滤掉毒化 turn 的 assistant 输出 |
| `tool_call` 返回 `{ block }` | `ToolCallEventResult` | 可在工具**执行前**拦下——毒化 turn 的工具调用若被拦，就不会产生 toolResult 入库 |

### 理想流程（消息层重采样，等价 Grok 语义）

```
检测到高置信循环（tool_call 重复 / thinking 尾部重复 / 无进展）
  → tool_call: { block }      # 拦下即将执行的毒化工具调用（避免产生 toolResult）
  → ctx.abort()               # 终止当前 poioned run
  → agent_end                 # run 结束
  → sendUserMessage(原始用户输入, { deliverAs: "nextTurn" })  # 同前缀重发
  → context 事件过滤           # 把被 abort 的 assistant 输出从下次 LLM 调用中剔除
  → 重采样 #2（前缀与第 1 次一致，毒化输出不进入 LLM）
  → 预算（如 2 次）内可再重试；耗尽→接受最后响应
```

### 卡点：事件 handler 拿不到命令上下文

- `sendUserMessage`/`waitForIdle` 只在 **`ExtensionCommandContext`**（`registerCommand`/`registerShortcut` handler）与 `withSession` 回调（`newSession`/`fork`/`switchSession`）里可用；
- `tool_call`/`message_update` 等**事件 handler** 只拿到 `ExtensionContext`（无 `sendUserMessage`）；
- 当前平台**没有**“事件 handler 里程序化调用某个命令/快捷键”的通道。

因此“abort(事件) → resend(命令上下文)”无法在现有 API 里直接串联。

> **实施状态（2026-08）：方案 B 已落地**（`extensions/loop-guard`）。检测改为 Grok 式保守：思考/文本分通道（思考默认阈值 5、文本 10）、短语最短 8 字符且需含字母、总量检测仅当近期窗口内出现重复才触发、默认阈值收紧（repeat=8、cycle=4、total=200）；打断改为**静默 abort + 单次通知**，并对误判后的**下一轮 run 启用冷却**（默认 1 轮不检测），直接消除“重复打断”。同前缀重采样目前**无法靠上游 API**（相关上游 issue #7277/#7345/#7293 均被拒或未合，详见 `docs/upstream-issue-event-resample.md`）；若要实现只能走 provider 包装（代价大）或继续用本方案。

### 两条可落地路径

| 路径 | 做法 | 代价 |
| --- | --- | --- |
| **A'（平台小补丁，推荐）** | 向 pi 提需求：让 `sendUserMessage` 在事件 ctx 可用（或提供“触发命令”的桥）；证明确有事件→消息层重采样的合理用例（本设计即证明） | 等待上游；改动小 |
| **A（provider 包装）** | `registerProvider(name, { streamSimple: wrapped })` 在 HTTP 层重采样（真正等价 Grok sampler） | 全局包装、多 provider/多 stream 形态兼容面大 |
| **B（先落地轻量版）** | 事件层检测 + `abort()` 静默终止 + 状态提示“检测到循环已中断”（不做同前缀重发），配合分通道/高阈值/无进展优化 | 不是“同前缀”，但立即可用 |

### 证据链

- `types.d.ts`：`ExtensionContext`(209) 无 `sendUserMessage`；`ExtensionCommandContext extends ExtensionContext`(254) 有（915-921）；`ReplacedSessionContext extends ExtensionCommandContext`(297) 有。
- 扩展官方文档 `extensions.md`：生命周期图 (290-314) 每个 turn 循环内有 `context (can modify messages)`（297）；`input` 事件 source 可来自 extension（898）；`sendUserMessage` 用于新会话 kickoff（1130）。
- loop-guard 现状：事件层检测器已具备（`tool_call` 重复、`message_update` 短语重复），缺的只是“重发”这一跳。

---

## 附：关键源码证据

- `xai-org/grok-build`: `crates/codegen/xai-grok-sampling-types/src/doom_loop.rs`(wire 协议+策略)、`xai-grok-sampler/src/doom_loop.rs`(collector)、`tests/test_doom_loop_recovery.rs`("丢弃毒化 turn、同前缀重采样、预算耗尽接受最后响应")
- Claude Code CHANGELOG 2.1.223: line 285/286(搜索/子agent 会话预算)、180(并发子agent上限)、182(max-budget-usd 停后台)、144(重试循环修复)
- `openai/codex` `codex-rs/core/src/tasks/lifecycle.rs`:纯 lifecycle 事件,无检测
- `microsoft/autogen` `python/packages/autogen-agentchat/src/autogen_agentchat/conditions/_terminations.py`:TokenUsageTermination 等声明式终止条件
- 本仓库 loop-guard 现状:`extensions/loop-guard/{loop-detector,output-loop-detector,index}.ts`
