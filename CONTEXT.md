# Pi Agent Workflow Context

本上下文描述 Pi Agent 中由任务驱动的临时 workflow，以及它与项目规则、工具能力和执行状态的关系。

## Language

**Workflow**：针对一次用户任务自动生成的、可观察并可恢复的执行计划。它在任务完成、取消或终止后结束，不是默认写入仓库的可复用 workflow 文件。
_Avoid_: Reusable workflow, workflow template（除非明确讨论未来的可复用能力）

**Workflow step**：workflow 中具有明确目标、依赖、所需能力和完成条件的单个工作单元。
_Avoid_: 任意 prompt 段落、未验证的模型意图

**Execution state**：描述 workflow 及其步骤当前是否待执行、执行中、已通过、失败、暂停或已取消的事实。
_Avoid_: 仅存在于聊天文本中的“已完成”描述

**Capability**：workflow 执行某类动作所需的受控能力，例如工作区读写、测试或网络访问。
_Avoid_: workflow 自己拥有的权限、permission escalation

**Verification**：判断某个 workflow step 是否真正完成的可检查条件，而不是模型对完成状态的自然语言声明。
_Avoid_: success message

## Workflow lifecycle

**Automatic generation**：系统根据用户任务和项目上下文决定是否生成 workflow，并生成本次任务的步骤。

**Automatic execution**：workflow 经过整体批准后可以连续执行步骤和修改文件，不要求用户对每个文件或步骤逐一确认；这不改变 capability 的授权和安全约束。

**Approval**：用户对 workflow 的完整预览做一次整体确认，使 workflow 从 pending approval 进入 execution state；approval 不是逐步确认，也不是 workflow 自己拥有的权限。

**Resumption**：Pi 重启后依据已持久化的 workflow 与 execution state 继续未完成任务，不依据旧聊天文本猜测状态，也不恢复已过期的 capability 或秘密。

**Bounded retry**：步骤失败后只允许在固定预算内重试；预算耗尽后 workflow 暂停并报告原因，不无限重新生成或执行。
