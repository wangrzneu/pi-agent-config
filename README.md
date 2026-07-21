# pi-agent-config

个人维护的 Pi Coding Agent 配置、扩展与工作流。

## 内容

- `extensions/plan-mode/`：只读规划模式
- `skills/pi-workflow/`：个人工作规范
- `prompts/`：可复用提示词模板
- `settings.example.json`：项目级 Pi 配置示例

## 安装

在 Pi 项目目录中执行：

```bash
pi -e /path/to/pi-agent-config/extensions/plan-mode/index.ts
```

也可以把扩展复制到全局目录：

```bash
cp -R extensions/plan-mode ~/.pi/agent/extensions/
cp -R skills/pi-workflow ~/.pi/agent/skills/
```

启动后使用 `/plan` 切换规划模式，或使用：

```bash
pi --plan -e /path/to/pi-agent-config/extensions/plan-mode/index.ts
```

## 设计原则

1. 规划阶段默认只读。
2. 任何写操作都必须在显式确认后执行。
3. 硬约束放在扩展的工具拦截器中，行为偏好放在 skill/prompt 中。
4. 配置尽量保持可移植，不绑定单一模型或 provider。

## 安全提醒

Pi 扩展可以执行任意代码。安装或启用前请审查源码；涉及真实凭据和生产代码时，优先使用容器或专用用户运行。
