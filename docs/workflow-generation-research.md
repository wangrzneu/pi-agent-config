# 自动生成 Workflow：同类项目设计调研

## 0. 调研范围与假设

本调研把“自动生成 workflow”理解为：用户给出一个目标后，Agent 根据项目上下文生成一份**可检查、可执行、可恢复的任务步骤**，而不是仅生成一段临时回答。

本仓库当前已有：

- 静态 `skills/` 与 `prompts/`，用于提供行为规范；
- `/plan` 只读规划模式，用于先生成计划；
- `work-status`，用于显示任务类型和摘要；
- 工具拦截器和 sandbox，用于执行阶段的硬约束。

因此，重点比较以下设计维度：工作流定义的载体、触发方式、步骤执行模型、状态持久化、人工批准点和安全边界。

> 说明：外部项目均优先引用官方文档或官方仓库；“对本仓库的启示”属于基于这些资料和现有代码的设计推断，不当作外部项目的原始事实。

## 1. 项目横向比较

| 项目 | 工作流/指令载体 | 触发方式 | 执行模型 | 持久化与恢复 | 主要启示 |
|---|---|---|---|---|---|
| Claude Code | `CLAUDE.md`、Skills、Subagents、Hooks | 上下文自动发现；命令或配置显式触发子 Agent；Hook 由事件触发 | 主 Agent 可调用专门 Agent；Hook 在固定生命周期点运行 | 会话与项目配置分离；Skill 本身是文件资产 | **发现**和**执行**分开；自动匹配不等于自动执行高风险动作 |
| OpenAI Codex | 分层 `AGENTS.md`、Skills | 按目录层级加载指令；Skill 可按任务需要使用 | Agent 在统一循环内使用指令和工具 | 指令与项目一起版本化；层级决定作用域 | 目录作用域是简单且有效的上下文选择器 |
| GitHub Copilot | Repository instructions、Prompt files、Custom agents | 按产品/文件约定加载；自定义 Agent 显式选择 | 不同 Agent 配置不同职责、工具和提示 | 配置文件进入仓库，可评审 | 用**角色配置**限制能力，比生成任意流程更容易治理 |
| Cline | Markdown Workflows | 用户用 slash command 显式调用 | 按 Markdown 步骤顺序执行，步骤中可包含用户输入和工具动作 | Workflow 文件可复用、可共享 | Markdown 适合人读和版本控制；显式调用降低误触发 |
| Roo Code | Custom Modes、规则文件 | 用户选择 Mode；规则按作用域应用 | Mode 将角色、工具权限和提示绑定在一起 | `.roomodes` 等配置可版本化 | **权限/角色**应是 workflow 的一等属性，而不是提示词中的软约定 |
| LangGraph | StateGraph、节点、边、检查点 | 程序显式构造图并调用 | 有状态图：节点处理状态，边决定路由，可循环 | Checkpointer 支持中断后恢复、人工介入 | 真正可恢复的 workflow 需要显式状态和边界，不应只依赖聊天记录 |

## 2. 代表性设计分析

### 2.1 Claude Code：自动发现的能力模块

Claude Code 将项目指令、Skills、Subagents 和 Hooks 分成不同扩展点：

- 项目级指令负责长期约束；
- Skill 是可复用的领域能力，带有描述，模型可以根据任务选择；
- Subagent 负责隔离职责和上下文；
- Hook 负责在生命周期事件上执行确定性动作。

**对自动生成 workflow 的启示：**

1. 不要让生成器把所有逻辑塞进一个巨大的 prompt；应拆成“任务识别、步骤规划、执行、校验”几个职责。
2. “模型建议使用某个能力”和“系统自动执行一个动作”必须有不同的信任等级。
3. 确定性约束（禁止写入、最大重试次数、必须通过测试）应由扩展或执行器强制，而不是仅写在生成文本中。

来源：

- [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills)
- [Claude Code Subagents](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- [Claude Code Hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)

### 2.2 OpenAI Codex：分层项目上下文

Codex 的 `AGENTS.md` 机制按目录提供项目指令。Agent 在某个工作目录下工作时，相关目录层级的指令会共同影响任务；指令文件可以和代码一起提交、评审和演进。

**对自动生成 workflow 的启示：**

1. 生成 workflow 时应记录它依据了哪些指令文件、技能和项目文件，避免之后无法解释生成结果。
2. 可以采用“项目级默认 workflow + 子目录覆盖”的作用域模型。
3. workflow 的生成结果应是仓库内可评审的资产，而不是只存在于模型上下文中的文本。

来源：

- [Codex `AGENTS.md` guide](https://developers.openai.com/codex/guides/agents-md/)
- [Codex Skills](https://developers.openai.com/codex/skills/)
- [OpenAI Codex repository](https://github.com/openai/codex)

### 2.3 GitHub Copilot：指令、Prompt 和 Agent 角色分层

Copilot 将仓库说明、可复用 prompt 和自定义 Agent 作为不同配置层。仓库说明适合普遍适用的编码规则；prompt/agent 适合特定任务或职责。

**对自动生成 workflow 的启示：**

1. “规则”与“任务步骤”不要混成同一种文件：规则描述约束，workflow 描述本次任务如何推进。
2. 生成器可以先选择一个角色/模板，再填充任务特定步骤，而不是每次从零生成完整行为规范。
3. 自定义 Agent 的工具范围应可见并可限制；workflow 不能绕过现有工具权限。

来源：

- [Adding repository custom instructions for GitHub Copilot](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot)
- [Creating custom agents for GitHub Copilot](https://docs.github.com/en/copilot/customizing-copilot/creating-custom-agents)

### 2.4 Cline：人可读、显式调用的 Markdown Workflow

Cline 的 Workflow 以 Markdown 文件保存，并通过 slash command 显式调用。它强调把重复的多步骤任务写成可复用流程，而不是依赖用户每次重新描述。

**对自动生成 workflow 的启示：**

1. Markdown 是第一版很合适的交换格式：用户可以审阅、修改和提交变更。
2. 生成后最好先展示预览，再由用户显式确认执行。
3. Markdown 可以作为输入/输出格式，但执行器仍需解析出受约束的内部步骤，不能直接把整段 Markdown 当 shell 指令。

来源：

- [Cline Workflows](https://docs.cline.bot/features/slash-commands/workflows)
- [Cline repository](https://github.com/cline/cline)

### 2.5 Roo Code：把角色、工具和规则绑定为 Mode

Roo Code 的 Custom Modes 将角色说明、工具能力和规则组织在一起，并允许项目配置覆盖或添加模式。

**对自动生成 workflow 的启示：**

1. 每个步骤应声明所需能力，例如只读检查、文件修改、测试或外部网络，而不是默认拥有全部工具。
2. 生成器应拒绝生成超出当前授权范围的步骤，或将其标记为需要批准。
3. workflow 与 mode 的关系可以是：Mode 提供稳定能力边界，Workflow 只编排具体任务。

来源：

- [Roo Code Custom Modes](https://docs.roocode.com/features/custom-modes)
- [Roo Code repository](https://github.com/RooCodeInc/Roo-Code)

### 2.6 LangGraph：显式状态图与恢复

LangGraph 把 workflow 表达为状态、节点和边：节点处理状态，边负责路由；图可以包含循环，并通过 checkpointer 保存状态，从而支持中断、恢复和人工介入。

**对自动生成 workflow 的启示：**

1. 如果目标包含“恢复执行”，仅保存模型消息或 Markdown 计划是不够的；至少需要步骤 ID、状态、输入摘要和结果引用。
2. MVP 不必一开始支持任意图。线性步骤加有限条件分支已经能覆盖大多数编码任务。
3. 循环必须有预算：最大尝试次数、最大步骤数或显式终止条件，避免生成的 workflow 失控。

来源：

- [LangGraph Workflows and Agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents)
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph repository](https://github.com/langchain-ai/langgraph)

## 3. 共同模式与反模式

### 共同模式

1. **声明与执行分离**：指令/角色/步骤负责描述意图，执行器负责工具调用、权限和生命周期。
2. **文件化和版本化**：可复用设计通常是仓库内文件，而不是隐藏在对话历史中。
3. **作用域明确**：项目、目录、角色和单次任务分别有不同的配置范围。
4. **显式的人机边界**：高风险写入、网络、凭据、远程执行或不可逆动作需要批准或硬约束。
5. **可观测状态**：步骤状态、失败原因、重试和最终验证结果应能被用户看到。

### 应避免的反模式

1. 让模型直接生成并执行任意 shell 脚本作为 workflow。
2. 把“步骤已完成”只定义为模型说了一句完成，而没有验证条件。
3. 生成无限循环或无限重试的流程。
4. 在生成 workflow 时静默修改仓库配置、skill 或权限。
5. 把项目规则、任务计划、执行日志和最终报告混写在一个文件中。
6. 让 workflow 自己提升工具权限；权限应来自当前 Pi 会话和 sandbox 授权。

## 4. 对本仓库的设计建议

### 推荐形态：Preview → Approve → Execute → Verify

建议采用一个混合模型：

1. **Generate**：根据用户目标、项目指令、可用 skill 和当前目录生成结构化 workflow。
2. **Preview**：以 Markdown/树状视图展示步骤、所需工具、风险和验证条件。
3. **Approve**：用户确认后才进入会修改文件或执行外部动作的阶段。
4. **Execute**：由现有 Agent loop 逐步执行，每步经过工具拦截器和 sandbox。
5. **Verify**：每步执行其验证条件；失败时进入有限重试或回到人工决策。
6. **Persist**：保存已批准 workflow 及执行状态，支持查看和恢复。

这比“生成后立即执行”安全，也比“只生成一份静态计划”更接近可恢复 workflow。

### 建议的最小内部模型

```ts
interface GeneratedWorkflow {
  id: string;
  goal: string;
  generatedAt: string;
  context: {
    cwd: string;
    instructionFiles: string[];
    skills: string[];
  };
  steps: WorkflowStep[];
  limits: {
    maxSteps: number;
    maxRetriesPerStep: number;
  };
}

interface WorkflowStep {
  id: string;
  title: string;
  instruction: string;
  requiredCapabilities: Array<"read" | "write" | "test" | "network">;
  dependsOn: string[];
  verification: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
}
```

第一版可以只支持线性步骤和 `dependsOn`，不支持模型生成任意代码、任意循环或动态权限提升。

### 与现有扩展的衔接

| 现有能力 | workflow 复用方式 |
|---|---|
| `plan-mode` | Generate/Preview 阶段继续只读；批准前禁止写工具 |
| `work-status` | 显示 `Plan`、`Implement`、`Test`，并增加当前 workflow step 摘要 |
| `skills/pi-workflow` | 保留为全局行为约束，不把任务状态写进 skill |
| `loop-guard` | 作为执行层的兜底；workflow 自身再加步骤/重试预算 |
| `sandbox` | 继续是硬安全边界；workflow 只能请求能力，不能授予能力 |
| `external-memory` | 可选保存决策和验证结论，但不应把未经批准的计划当作事实记忆 |

## 5. 建议的 MVP 边界

### 应包含

- 根据任务自动生成 workflow，并通过 `/workflow` 支持查看、批准、暂停、恢复和取消；
- 结构化步骤：目标、依赖、能力、验证、状态；
- 整体预览和用户批准后才进入执行态；
- 批准后的线性执行、失败停止、有限重试；
- 可读的持久化文件或 session state；
- 针对解析失败、步骤越界和验证失败的测试。

### 暂不包含

- 自动修改 `skills/`、项目规则或 Pi 配置；
- 任意 DAG/循环编排；
- workflow 自己申请新的 sandbox、凭据或网络权限；
- 多 Agent 并行写入同一工作区；
- 把未经用户确认的自然语言计划直接当作完成结果。

## 6. 已确认的产品决策

根据需求确认，首版采用以下定义和行为：

| 问题 | 决策 |
|---|---|
| Workflow 的生命周期 | **单次任务的临时执行计划**，不是生成可复用的仓库 workflow 文件 |
| 生成触发方式 | 根据用户任务和项目上下文**自动识别并生成**，不要求用户显式执行 `/workflow` |
| 文件修改 | 生成并开始执行后，允许自动修改文件，不要求每一步单独确认 |
| 跨重启能力 | 必须持久化 workflow 和执行状态，Pi 重启后可以识别并恢复未完成任务 |
| 失败策略 | 失败后进行**有限重试**；超过预算后暂停并报告，不无限重新规划 |
| 任务范围 | 首版覆盖需要依赖关系和验证的多步骤任务 |

### 权限解释

“允许自动修改文件”只表示已批准的 workflow 不需要逐文件确认；它不改变 Pi 的安全模型：

- workflow 不能自行提升工具、文件、网络或凭据权限；
- 每个步骤声明所需能力，执行时仍由现有 tool interceptor 和 sandbox 执行；
- 如果某步骤需要尚未授权的能力，workflow 必须暂停并请求授权，而不是绕过授权；
- 跨 Pi 重启恢复的是已持久化的计划和状态，不代表恢复已过期的权限或秘密。

### 由需求带来的设计变化

最终采用整体“Preview → Approve → Execute”流程：

1. Agent 在识别到适合编排的任务后自动生成临时 workflow；
2. 系统展示完整预览，包括目标、步骤、依赖、能力和验证条件；
3. 用户整体批准后 workflow 才进入执行态；拒绝或没有交互确认能力时保持等待审批；
4. 执行阶段允许连续修改文件，但权限不足、验证失败或达到重试上限时暂停；
5. 启动新 Pi 会话时恢复已批准的未完成 workflow；等待审批的 workflow 不会自动执行。

## 7. 仍需在实现中固定的边界

这些不是产品方向问题，但需要落实为可测试的规则：

1. 自动识别的最小条件：哪些任务进入 workflow，哪些任务继续使用普通 Agent loop；
2. 持久化位置、文件格式、原子写入和损坏恢复策略；
3. 跨重启时如何确认工作区没有发生冲突；
4. 外部动作的幂等性和重复执行保护；
5. 每类步骤的验证条件与最大重试次数；
6. 用户如何暂停、取消、查看和恢复 workflow。

## 8. 结论

最适合本仓库的方向不是让模型生成“可执行脚本”，而是生成一份**自动启动、受能力约束、可跨重启恢复的结构化任务计划**，再由现有 Pi 工具拦截器负责执行安全边界。

第一版建议采用“自动识别 + 自动执行 + 持久化状态 + 线性步骤 + 每步验证 + 有限重试”的设计。涉及工作区以外的动作时，需要额外考虑幂等性、外部授权和重启后的重复执行风险。

这样可以复用现有的 plan mode、work-status、loop guard 和 sandbox，同时保留未来增加分支和可复用 workflow 文件的空间。

## 9. 首版实现映射

当前实现将 workflow 状态写入 Pi 当前 session 的 `custom` entry，而不是写入仓库文件或另建数据库。这样可以天然跟随 Pi 的 session branch，并由 `session_start` 从当前 branch 恢复最后一个有效状态。

- `extensions/workflow/workflow-state.ts`：校验、依赖排序、状态转移、有限重试和中断恢复；
- `extensions/workflow/index.ts`：自动提示注入、`workflow` 工具、`/workflow` 命令和 session 生命周期接线；
- `workflow` 工具只记录步骤和状态，不执行任意脚本；实际文件、bash 和网络动作继续通过 Pi 原有工具；
- `session_start` 只对已批准且未完成的 workflow 触发继续执行；等待审批的 workflow 不会自动继续；
- 正在执行的步骤会被恢复为 pending，避免把进程中断误判为完成；
- 暂停、取消和完成状态不会自动继续，避免重启后重复执行不可逆外部操作；
- `approve` 只通过用户确认对话框或 `/workflow approve` 触发，不向模型暴露审批动作。
