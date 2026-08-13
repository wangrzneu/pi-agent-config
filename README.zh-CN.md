<div align="center">

# 🧰 Pi Agent Config

**为 [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 量身定制的个人配置、扩展与工作流**

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-9cf.svg)](#)
[![Pi Package](https://img.shields.io/badge/Pi%20Package-ready-ff69b4.svg)](#)

一套经过精心整理的扩展、技能与提示词，让 Pi Coding Agent **更安全**、**更专注**、**更高效** —— 自带沙箱、规划模式与丰富的 TUI 工具集。

</div>

---

## ✨ 功能一览

| 功能 | 说明 |
|---|---|
| 🔒 **规划模式** | 只读的规划模式，先思考再行动 |
| 📖 **Markdown 阅读器** | 在 Pi TUI 中渲染本地 Markdown——支持搜索、图片与 Mermaid |
| 🏷️ **工作状态** | 在 TUI 页脚实时显示任务摘要与工作类型 |
| 💬 **临时提问** | `/btw` 侧问题，绝不污染主会话 |
| 🌐 **SSH 工具** | 轻量、按能力细分的 SSH 执行、传输与远程作业 |
| 🛡️ **沙箱** | 对本地 shell 命令实施 fail-closed 的操作系统级沙箱 |
| 🧠 **外部记忆** | 可选的项目级同步目录记忆，压缩时捕获、两阶段召回 |
| 🔁 **循环守卫** | 检测重复的工具调用或重复的输出语句，打断卡住的 agent 循环 |
| 🧭 **工作流 skill** | 精简的默认工作规范 |
| 🧩 **提示词** | 按需使用的 review / debugging / architecture 提示词 |
| 📚 **文档** | 代码探索、外部项目与安全边界参考文档 |

## 📦 内容

| 路径 | 说明 |
|---|---|
| `extensions/plan-mode/` | 只读规划模式 |
| `extensions/markdown-viewer/` | 在 Pi TUI 中打开并渲染本地 Markdown 文件 |
| `extensions/work-status/` | 在 Pi TUI 中显示当前任务和工作类型 |
| `extensions/btw/` | 临时提问，不改变主会话 |
| `extensions/ssh-tools/` | 按需发现的 SSH 执行、文件传输和远程作业工具 |
| `extensions/sandbox/` | 对本地 shell 命令实施 fail-closed 的操作系统级沙箱 |
| `extensions/external-memory/` | 可选的项目级同步目录记忆，压缩时捕获、两阶段召回 |
| `extensions/loop-guard/` | 检测重复的工具调用并打断卡住的 agent 循环 |
| `skills/pi-workflow/` | 精简的默认工作规范 |
| `prompts/` | 按需使用的 review、debugging 和 architecture 提示词 |
| `docs/` | 代码探索、外部项目和安全边界参考文档 |
| `settings.example.json` | 项目级 Pi package 配置示例 |

> 💡 **外部记忆**按项目可选启用：先将 `PI_AGENT_MEMORY_ROOT` 设为绝对路径，再在该项目中运行
> `/memory on`。证据以不可变的 JSONL 分块写入，通过 `/memory search` 或 `memory_recall` 工具召回。
> 详见 [`docs/external-memory.md`](docs/external-memory.md)。

### 📚 文档

| 文档 | 主题 |
|---|---|
| `docs/external-memory.md` | 同步目录外部记忆设计 |
| `docs/external-memory-test-plan.md` | 外部记忆验证方案 |
| `docs/sandbox.md` | 沙箱行为、配置与安全边界 |
| `docs/sandbox-design.md` | sandbox 扩展的架构与设计决策 |
| `docs/sandbox-apple-container.md` | 实验性的 Apple Container VM + Process sandbox 叠加隔离 |
| `docs/ssh-tools.md` | SSH 工具要求、行为与安全边界 |
| `docs/security.md` | 安全模型概览 |
| `docs/exploration.md` | 代码探索指引 |
| `docs/external-projects.md` | 处理外部项目 |

## 📋 前置条件

需要 Node.js **22.19.0 或更高版本**。安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

确认环境：

```bash
node --version
pi --version
```

## 🚀 安装

### 🏷️ 安装指定 Release（推荐）

固定到当前稳定版本，避免更新 package 时意外切换到更新的代码：

```bash
# 全局安装
pi install git:github.com/wangrzneu/pi-agent-config@v0.1.0

# 项目级安装（写入 .pi/settings.json）
pi install -l git:github.com/wangrzneu/pi-agent-config@v0.1.0
```

可以将 `v0.1.0` 替换为任意已发布的 [Release tag](https://github.com/wangrzneu/pi-agent-config/releases)，也可以使用完整的 Git commit SHA。执行 `pi update --extensions` 或 `pi update --all` 不会将固定的 ref 自动升级到新版本。升级已有安装时，请明确安装目标新版本：

```bash
pi install git:github.com/wangrzneu/pi-agent-config@vX.Y.Z
# 项目级安装请增加 -l。
```

### 🌍 全局安装最新开发版本

不指定 tag 时，会从仓库默认分支安装，并对所有项目生效：

```bash
pi install git:github.com/wangrzneu/pi-agent-config
```

### 📁 为项目安装最新开发版本

在目标项目目录执行，配置会写入 `.pi/settings.json`：

```bash
pi install -l git:github.com/wangrzneu/pi-agent-config
```

也可以把 `settings.example.json` 的内容合并到项目的 `.pi/settings.json`。

### 🗂️ 本地目录

开发或使用本地检出版本时，先安装 package 依赖：

```bash
cd /absolute/path/to/pi-agent-config
npm install
pi install -l /absolute/path/to/pi-agent-config
```

只在当前运行中临时加载整个 package：

```bash
pi -e /absolute/path/to/pi-agent-config
```

## ✅ 验证

```bash
pi list
pi
```

启动后使用 `/plan` 切换规划模式。

## 🧰 使用指南

### 🛡️ 沙箱化的本地命令

在 macOS 和 Linux 上，本地 `bash` 与用户 `!` 命令会进入 fail-closed 的操作系统级沙箱。
默认只允许读写工作区，同时允许访问常见包仓库、启动本地测试服务，并为 git/编译器提供操作系统临时目录。

- 🐍 **Python** 操作应使用工作区的 `.venv`（`pi-workflow` skill 工作约束）：先
  `python3 -m venv .venv` 创建，再在用到 `python`/`pip` 的同一条命令里
  `source .venv/bin/activate`（每次 bash 调用都是新 shell），让 pip 与脚本避开 home 目录依赖；
  详见 [`docs/sandbox.md`](docs/sandbox.md) 的 “Python environments”。
- 🔐 **工作区外的用户文件**必须通过 `sandbox_authorize_read`、`sandbox_authorize_write` 或
  `/sandbox allow-read|allow-write <路径>` 获得当前 session 的明确授权；Pi 的直接读取、搜索、
  目录、写入和编辑工具也使用相同权限门。
- 🌐 **未列入白名单的网络域名**会暂停连接并请求授权。精确主机名授权持续到当前 session，
  可用 `/sandbox revoke-network` 清除；显式拒绝规则和 `strictAllowlist` 仍会硬性阻止访问。
- ⏱️ 前台命令没有隐式超时，并支持流式输出和进程组取消，适合耗时较长的构建与测试。
- 🍎 backend 默认为 `auto`：Apple Container 条件满足时自动启用，否则 Pi 会提示原因并使用
  Process sandbox。可通过 `--sandbox-mode auto|process|apple-container` 覆盖。
- ⌨️ 使用 `/sandbox` 查看请求/实际采用的 backend 和生效策略，修改配置后执行
  `/sandbox reload`；只有明确传入 `--no-sandbox` 才会绕过沙箱。

### 💬 `/btw` 临时提问

使用 `/btw <问题>` 发起一次能看到当前会话上下文的临时提问。它使用当前模型，并可通过隔离的
只读 `read`、`grep`、`find` 和 `ls` 工具查看或搜索文件。问题、回答和工具结果都不会写入主会话。

每次调用只生成一个回答；新问题需要再次执行 `/btw <问题>`。无参数执行 `/btw` 可重新打开
最近一次回答。回答视图支持滚动、左右切换历史、`c` 复制、`x` 清空，以及使用 `q`、`Esc`、
`Enter` 或 `Space` 关闭。

### 🌐 远程 SSH 工作

远程 SSH 工作默认只暴露一个轻量的 `ssh_enable` 工具。完成主机与能力授权后，
模型只激活当前任务需要的能力组：前台命令执行、二进制安全的上传/下载，或者支持查询状态和
取消的后台作业。

- 每个主机一次授权即可覆盖对应能力组中的普通操作，并持续整个 session；新增能力、sudo 和
  取消作业仍需明确确认。
- 连接超时、重试次数和指数退避可通过 `ssh_enable` 配置。
- 🔑 需要 SSH 或 sudo 密码时，扩展通过遮罩输入读取，并且只保存在进程内存中，不会成为模型
  工具参数。
- 连接重试包含可识别的认证失败和 Host Key 失败，但不会绕过 OpenSSH 的 Host Key 校验；对于
  启用账号锁定策略的系统，应设置较低的重试次数。
- 使用 `/ssh-tools` 查看当前状态，或用 `/ssh-tools off|on|reset` 控制功能。
  具体要求、行为和安全边界见 [`docs/ssh-tools.md`](docs/ssh-tools.md)。

### 🏷️ 工作状态

Agent 运行时，页脚会显示当前任务摘要及工作类型：设计、计划、实现、测试、评审、修复或探索。
当前选中的模型会执行一次关闭扩展思考的短分类请求，工作提示则显示当前工具的具体操作。
分类结果无效、请求失败或超时后不会回退，也不会显示工作状态。分类结果不会写入会话或主模型上下文。

### 🔁 循环守卫

默认关闭。Agent 运行期间，循环守卫会跟踪工具调用**和模型的流式输出**并检测卡死循环：

- 同一工具调用连续重复（5 次起，可配置）；
- 相同的 2/3 步调用循环；
- 单次 run 超过 120 次工具调用；
- 流式输出中同一句话或短语重复出现（6 次起，可配置）——这能抓住只在嘴上重复意图
  （“现在执行 lldb……”、“现在执行 lldb……”）却从不真正发出工具调用的模型。

检测到后询问是否中止当前 run（print/RPC 模式直接中止）。每次会话用 `/loop-guard on` 开启（或通过扩展的
`defaultMode` 配置永久开启）。使用 `/loop-guard` 查看状态，或用 `off|on|reset` 禁用、重新启用或清零计数。

默认关闭的原因是短语重复检测是基于字符串的启发式，会对合法代码误报（例如一个窗口内出现多个相同的
`return err` 行）；要默认开启需要语言学层面的判断，而不是字符串匹配。

### 📖 Markdown 阅读器

使用 `/md <path>` 或 `/markdown <path>` 打开本地 `.md`、`.markdown` 文件：

```text
/md README.md
/md "docs/design notes.md"
```

阅读器支持方向键、`j`/`k` 滚动，`PageUp`/`PageDown` 翻页，`g`/`G` 跳转首尾，
并使用 `q` 或 `Esc` 关闭。其他功能：

- `/` 输入正文搜索，`n`/`N` 跳转到下一个或上一个结果。
- `d` 打开目录导航，只列出目录和 Markdown 文件。
- `l` 或 `o` 打开链接列表；本地 Markdown 链接在阅读器内跳转，其他链接交给系统打开。
- 自动渲染本地、HTTP(S) 和 data URL 中的 PNG、JPEG、GIF、WebP 图片；终端不支持图片协议时
  显示图片信息。
- 将 `mermaid` 代码块本地渲染为 Unicode 图表，不调用远程渲染服务。
- `r` 手动刷新；文件变化后也会自动刷新。

> ⚠️ 每份文档最多渲染 32 张图片，每张最多 8 MiB，远程图片请求 8 秒超时。远程图片会产生网络
> 请求；不要用阅读器打开包含不可信跟踪图片的文档。

## 🧪 测试

可以运行以下命令验证仓库中的回归测试：

```bash
npm test
```

## 🔄 更新与移除

```bash
pi update --extensions
pi update git:github.com/wangrzneu/pi-agent-config
pi remove git:github.com/wangrzneu/pi-agent-config
```

如果使用项目级安装，移除时增加 `-l`：

```bash
pi remove -l git:github.com/wangrzneu/pi-agent-config
```

## ⚡ Token 使用

- 默认只加载精简的 `skills/pi-workflow/SKILL.md`。
- `prompts/` 中的模板只在对应任务中按需使用。
- `docs/` 是参考材料，不应自动加入每次任务的上下文。
- plan mode 的模型提醒只在进入模式后注入一次；只读限制由工具拦截器持续执行。
- 每个未缓存任务的工作状态会发起一次关闭思考的短模型请求，消耗少量 token，但不会把结果加入
  会话上下文。
- 每个 `/btw` 问题会运行一个带有较小输出与工具调用预算的独立模型循环；只读工具结果是临时的，
  问答不会写入会话。
- Markdown 阅读器、目录、搜索、图片和 Mermaid 都只在 TUI 扩展进程中处理，不会把内容加入模型
  上下文。
- SSH 默认只暴露精简的 `ssh_enable` 选择器；主机/能力授权是 session 级的，同一主机后续再次调用
  `ssh_enable` 会直接恢复工具而不重新弹框；作业状态和取消工具只为已跟踪作业保留。`/ssh-tools
  off|reset` 会撤销授权。该过程不发起额外模型分类请求。
- Sandbox 不会增加模型请求，也不会向会话写入持久内容；除沙箱化 bash 外，只暴露精简的读写
  授权工具。未列入白名单的域名通过直接用户确认授权，不会触发额外模型请求。

## 🎯 设计原则

1. **规划阶段默认只读。**
2. **硬约束**放在扩展的工具拦截器中，**行为偏好**放在 skill 或按需 prompt 中。
3. **详细流程**放在文档中，避免增加默认上下文。
4. **配置保持可移植**，不绑定单一模型或 provider。

## 🔒 安全提醒

本地命令沙箱只约束 shell 子进程，不会隔离 Pi 的直接文件工具、package 或扩展；Plan mode
也仍然只是防误操作机制。安装前请审查源码，处理真实凭据、生产代码或恶意项目时应使用容器、
虚拟机或专用低权限用户。详见 [`docs/security.md`](docs/security.md)。

## 📄 License

[MIT](LICENSE) © [Renzheng Wang](https://github.com/wangrzneu)
