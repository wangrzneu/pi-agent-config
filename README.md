# pi-agent-config

个人维护的 Pi Coding Agent 配置、扩展与工作流。

## 内容

- `extensions/plan-mode/`：只读规划模式
- `extensions/markdown-viewer/`：在 Pi TUI 中打开并渲染本地 Markdown 文件
- `skills/pi-workflow/`：精简的默认工作规范
- `prompts/`：按需使用的 review、debugging 和 architecture 提示词
- `docs/`：代码探索、外部项目和安全边界参考文档
- `settings.example.json`：项目级 Pi package 配置示例

## 前置条件

需要 Node.js 22.19.0 或更高版本。安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

确认环境：

```bash
node --version
pi --version
```

## 安装

### 全局安装

安装后对所有项目生效：

```bash
pi install git:github.com/wangrzneu/pi-agent-config
```

### 项目安装

在目标项目目录执行，配置会写入 `.pi/settings.json`：

```bash
pi install -l git:github.com/wangrzneu/pi-agent-config
```

也可以把 `settings.example.json` 的内容合并到项目的 `.pi/settings.json`。

### 本地目录

开发或使用本地检出版本时，先安装 Mermaid 渲染依赖：

```bash
cd /absolute/path/to/pi-agent-config
npm install
pi install -l /absolute/path/to/pi-agent-config
```

只在当前运行中临时加载整个 package：

```bash
pi -e /absolute/path/to/pi-agent-config
```

## 验证

```bash
pi list
pi
```

启动后使用 `/plan` 切换规划模式。

使用 `/md <path>` 或 `/markdown <path>` 打开本地 `.md`、`.markdown` 文件：

```text
/md README.md
/md "docs/design notes.md"
```

阅读器支持方向键、`j`/`k` 滚动，`PageUp`/`PageDown` 翻页，`g`/`G`
跳转首尾，并使用 `q` 或 `Esc` 关闭。其他功能：

- `/` 输入正文搜索，`n`/`N` 跳转到下一个或上一个结果。
- `d` 打开目录导航，只列出目录和 Markdown 文件。
- `l` 或 `o` 打开链接列表；本地 Markdown 链接在阅读器内跳转，其他链接交给系统打开。
- 自动渲染本地、HTTP(S) 和 data URL 中的 PNG、JPEG、GIF、WebP 图片；终端不支持图片协议时显示图片信息。
- 将 `mermaid` 代码块本地渲染为 Unicode 图表，不调用远程渲染服务。
- `r` 手动刷新；文件变化后也会自动刷新。

每份文档最多渲染 32 张图片，每张最多 8 MiB，远程图片请求 8 秒超时。远程图片会产生网络请求；不要用阅读器
打开包含不可信跟踪图片的文档。

可以运行以下命令验证仓库中的回归测试：

```bash
npm test
```

## 更新与移除

```bash
pi update --extensions
pi update git:github.com/wangrzneu/pi-agent-config
pi remove git:github.com/wangrzneu/pi-agent-config
```

如果使用项目级安装，移除时增加 `-l`：

```bash
pi remove -l git:github.com/wangrzneu/pi-agent-config
```

## Token 使用

- 默认只加载精简的 `skills/pi-workflow/SKILL.md`。
- `prompts/` 中的模板只在对应任务中按需使用。
- `docs/` 是参考材料，不应自动加入每次任务的上下文。
- plan mode 的模型提醒只在进入模式后注入一次；只读限制由工具拦截器持续执行。
- Markdown 阅读器、目录、搜索、图片和 Mermaid 都只在 TUI 扩展进程中处理，不会把内容加入模型上下文。

## 设计原则

1. 规划阶段默认只读。
2. 硬约束放在扩展的工具拦截器中，行为偏好放在 skill 或按需 prompt 中。
3. 详细流程放在文档中，避免增加默认上下文。
4. 配置保持可移植，不绑定单一模型或 provider。

## 安全提醒

Plan mode 是防误操作机制，不是安全沙箱。Pi package 和扩展可以执行任意代码；安装前请审查源码，处理真实凭据、生产代码或不可信项目时应使用容器或专用低权限用户。详见 `docs/security.md`。
