# Claude Code 的 Sandbox 机制调研

调研目标：弄清楚 Claude Code（Anthropic 的 CLI 编程 Agent）**产品层面**如何使用沙箱，以及其底层 **ASRT（Anthropic Sandbox Runtime, `@anthropic-ai/sandbox-runtime`）** 是如何实现的。这份笔记用于与本仓库 `extensions/sandbox`（Pi 的沙箱扩展）做对比。

## 来源（全部为一级来源）

| 来源 | 说明 |
| --- | --- |
| 本地安装的 `@anthropic-ai/claude-code` v2.0.42（Homebrew，2025-11） | 内置 `cli.js`（约 10MB 打包后的产品源码），沙箱逻辑可完整逆向 |
| npm registry 上的 `@anthropic-ai/claude-code@2.1.223`（最新，CHANGELOG HEAD） | `CHANGELOG.md` 记录了沙箱功能从发布到现在的全部演进 |
| 仓库内 `node_modules/@anthropic-ai/sandbox-runtime@0.0.70` | ASRT 的 README + `dist/*.d.ts`（完整配置 schema） |
| anthropics/claude-code GitHub 仓库 | CHANGELOG.md 等（raw.githubusercontent.com / api.github.com 可达） |

> 注意：官方文档站（docs.claude.com / code.claude.com / docs.anthropic.com）在本网络环境下不可达（代理 allowlist 阻断 / 连接失败），因此产品文档层面的细节以 cli.js 与 CHANGELOG 为准。

---

## 1. 一句话结论

Claude Code 的沙箱 = **进程级 OS 沙箱（macOS Seatbelt / Linux bubblewrap），只包 Bash 工具产生的子进程**；Claude Code 自己的 `Read`/`Write`/`Edit` 等直接文件工具不走沙箱，而是走内置的**权限拦截系统**（allow/deny/ask 规则 + 交互式许可）。沙箱的规则**直接从既有的 permission rules 派生**（`permissions.allow/deny` 中的 `domain:` 规则等），而不是一套独立的配置体系。底层 OS 沙箱由官方开源包 ASRT（`@anthropic-ai/sandbox-runtime`）提供，Pi 的沙箱扩展也正是基于同一运行时。

---

## 2. 启用与开关（产品层）

### 2.1 配置入口

沙箱配置在 `settings.json` 的 `sandbox` 块。配置来源有五级（均走同一个 schema，`cli.js` 的 `zU()` 函数）：

| 级别 | 路径 |
| --- | --- |
| userSettings | `~/.claude/settings.json` |
| projectSettings | `<cwd>/.claude/settings.json` |
| localSettings | `<cwd>/.claude/settings.local.json`（`/sandbox` 菜单的切换写到这里） |
| policySettings（企业受管） | `/Library/Application Support/ClaudeCode/managed-settings.json`（macOS）/ `/etc/claude-code`（Linux）/ `C:\ProgramData\ClaudeCode`（Windows） |
| flagSettings | `--settings <file>` 指定的文件 |

生效优先级（同名以更高优先级覆盖）：`cli.js` 中 `pm8()` 检测 `flagSettings`/`policySettings` 里是否出现 sandbox 配置，用于判断企业策略是否锁定了沙箱设置（`areSandboxSettingsLockedByPolicy`）。

### 2.2 v2.0.42 的 `sandbox` 配置 schema（直接取自 cli.js，含描述原文）

```
sandbox: {
  network: {
    allowUnixSockets: string[]   // 允许 Unix socket 做本地 IPC（SSH agent、Docker 等）；缺省=全部阻止
    allowLocalBinding: boolean   // 允许绑定本地地址（localhost 端口）；缺省 false
    httpProxyPort: number        // 网络过滤 HTTP 代理端口；缺省自动起一个
    socksProxyPort: number       // 网络过滤 SOCKS 代理端口；缺省自动起一个
  }
  ignoreViolations: { <command 模式>: string[] }   // 匹配该命令时忽略指定路径的沙箱违规
  excludedCommands: string[]     // 'Commands that should never run in the sandbox (e.g., ["git", "docker"])'
  autoAllowBashIfSandboxed: boolean  // 默认 true；沙箱内执行的命令不再逐个弹出许可
  enableWeakerNestedSandbox: boolean // 默认 false；弱化版沙箱以适配无特权 Docker 环境（--proc 挂载失败）
  allowUnsandboxedCommands: boolean  // 默认 true；允许模型用 dangerouslyDisableSandbox 逃出沙箱
  enabled: boolean               // 'Enable sandboxed bash'
}
```

注意 v2.0.42 里 `network` 只有以上四个键；**没有** `allowedDomains/deniedDomains`（域名白名单/黑名单），也**没有** `filesystem.allowRead/denyRead/allowWrite/denyWrite`。域名的允许/拒绝完全走 permission rules（见 §5.3）。这两个 `filesystem`/`network.allowedDomains` 块是后来（2.1.x，配合新 ASRT schema）才加进产品配置的。

### 2.3 默认是否开启？

- v2.0.42（本地版本）：`isSandboxingEnabled`（`eu()`）返回 `N0().sandbox?.enabled ?? false` —— 未显式配置时**默认关闭**。这个构建里也没发现首次运行的 onboarding 提示（未找到相关 UI 文案）。
- 较新版本：CHANGELOG 显示 2.1.x 期间出现了 "bash commands will be sandboxed" 启动横幅，随后又移除（"Removed the 'bash commands will be sandboxed' startup banner — sandbox status still shows in `/status`"），说明后续版本已把沙箱**默认开启**（对未破坏的环境）。要精确确认 2.1.223 的默认值需要看新 cli.js（原生二进制包，本网络下载超时），建议以官方文档 "sandboxing" 页为准。
- 平台门槛：`isSandboxingEnabled` 只对 `macos`/`linux` 返回可用（`VQQ()`）；Windows 上启用设置会被忽略并可能出 "Sandbox dependencies missing" 告警（后版本已修）。Linux 还会检查 `bwrap` + `socat` 两个二进制是否在 PATH（`SdA()`），缺失时 v2.0.42 **静默降级为不沙箱**；后续版本才加了显式告警（"Fixed silent sandbox disable ... now shows a visible startup warning"）和 `sandbox.failIfUnavailable`（缺依赖直接报错退出，fail-closed）。

### 2.4 CLI 标志

- **没有 `--sandbox` 独立标志**（v2.0.42 中未解析到）。沙箱通过设置开启。
- `--dangerously-skip-permissions`：跳过所有权限检查（"Bypass all permission checks. Recommended only for sandboxes with no internet access."）。这不是沙箱开关，是权限系统开关。
- `--allow-dangerously-skip-permissions`：允许把上面的跳过作为选项启用（默认关闭）。
- `--settings <file>`：指定叠加的 flagSettings。

### 2.5 沙箱与权限模式的关系

权限模式（default / acceptEdits / plan / bypassPermissions）控制的是**许可弹窗**（permission prompts）。沙箱开启后，配合 `autoAllowBashIfSandboxed: true`（默认），**在沙箱内执行的命令不再逐条弹许可** —— 沙箱变成了"静默的边界"。CHANGELOG 中多次修复了这两者的联动（例如「auto mode 下沙箱网络许可弹窗不应出现」「excludedCommands 逃出沙箱的命令仍应被 Bash ask 规则拦下」）。

---

## 3. 每次执行的包装（wrapWithSandbox）

入口逻辑（`cli.js`，`am8()` 与 `m4A()`）：

```
m4A(): Bash 工具本次调用是否进沙箱？
  = isSandboxingEnabled()
  && !(command.dangerouslyDisableSandbox && allowUnsandboxedCommands)
  && command 非空
  && !excludedCommands 匹配（exact 命令 或 prefix 前缀）
```

- macOS 分支：`sandbox-exec -p <动态生成的 seatbelt profile> bash -c 'export <代理环境变量> && <命令>'`
- Linux 分支：`bwrap <挂载/网络参数> bash -c <命令>`（必要时在前面加 socat 桥启动语句）
- 包装对象是**整条 shell 命令字符串**；进程树整体都在沙箱内。

`excludedCommands` 匹配是 exact/prefix 两类（`HBI()`）：命令完全相等，或以 `"命令 "` 前缀开头。示例描述写的是 `["git", "docker"]`。

---

## 4. 底层实现（ASRT / `@anthropic-ai/sandbox-runtime`）

Claude Code 从 2025 中开始把 OS 层沙箱做成开源库 ASRT（研究预览），现（0.0.70）同时作为 `/srt` CLI 提供。本仓库的 pi 沙箱扩展正是 `SandboxManager.initialize(config)` + `wrapWithSandbox(cmd)` + 每次 `spawn` 的用法。

### 4.1 平台原语

| 平台 | 原语 | 说明 |
| --- | --- | --- |
| macOS | `/usr/bin/sandbox-exec` + 动态生成 Seatbelt SBPL profile | 系统自带，零额外依赖 |
| Linux | bubblewrap（`bwrap`）+ `socat` + 可选 seccomp | 需要装 bwrap、socat、ripgrep；Ubuntu 24.04+ 需放开 `kernel.apparmor_restrict_unprivileged_userns` |
| Windows | 自研 `srt-win.exe` + WFP + NTFS ACL（alpha） | 见 §4.5 |

### 4.2 macOS：Seatbelt profile（cli.js 里的模板，可逐行还原）

profile 是**每次执行动态生成**的（`_m8()`），结构如下：

```
(version 1)
(deny default (with message "<log tag>"))     ← 全部默认拒绝，fail-closed
; 进程权限
(allow process-exec) (allow process-fork) (allow signal (target same-sandbox))
(allow process-info* ...) (allow mach-priv-task-port ...)
(allow user-preference-read)
; Mach IPC —— 只放行具体服务名（无通配符）：
;   audio.systemsoundserver, distributed_notifications@Uv3, FontObjectsServer, fonts,
;   logd, lsd.mapdb, PowerManagement.control, system.logger, system.notification_center,
;   trustd.agent, system.opendirectoryd.{libinfo,membership}, bsd.dirhelper,
;   securityd.xpc, coreservices.launchservicesd
(allow ipc-posix-shm) (allow ipc-posix-sem)     ; Python multiprocessing 需要
; IOKit：只允许 IOSurfaceRootUserClient / RootDomainUserClient / IOSurfaceSendRight + 属性读取
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
; sysctl：只允许 ~40 个白名单键（hw.*、kern.* 只读，无 kern.proc 类）
;  ---- 以上是"基础"，以下按配置追加 ----
; 文件读（ym8()）
(allow file-read*)                              ; 无 deny 规则时全开
(deny file-read* (regex <glob 转正则>) / (subpath <路径>) (with message ...))  ; 按 denyRead
; 文件写（km8()）——注意语义与读相反：
(allow file-write* (subpath <默认允许路径>))      ; 先列默认可写路径
(allow file-write* (subpath/regex <allowWrite>))
(deny file-write* (subpath/regex <denyWrite + 强制 deny 列表>) ...)
; 网络（_m8 结尾部分）：
;   needsNetworkRestriction=false 时 → (allow network*)
;   allowLocalBinding=true  → 仅允许 loopback bind/inbound/outbound
;   httpProxyPort/socksProxyPort → 只允许连到 localhost 的代理端口
;  ≈ 除代理端口外无任何出站网络
```

关键点：
- **读是 deny-then-allow**（默认全读，按 deny 规则挖掉），**写是 allow-only(默认不允许，逐个路径允许，deny 优先)**。这也是 ASRT README 明示的规则语义。
- profile 里有 `com.apple.trustd.agent` 的默认放行（用于系统信任库 TLS 验证）。
- "Essential permissions - based on Chrome sandbox policy" 注释：Anthropic 明确参考了 Chrome 沙箱的策略。
- mock 的违规消息：每条 deny 规则带 `(with message "<logTag>")`，logTag 是 `CMD64_<hash>_END_<随机>`，用于把系统日志中的违规和具体命令对应起来（`Sm8()`）。

### 4.3 macOS 默认文件系统策略（无任何 rules 时）

从 `qQQ()`（默认 allowWrite）+ `Ij1()` / `Qj1()` 可以还原产品的默认行为：

- **读**：全放行（无 deny 规则），即 home、`~/.ssh` 等默认可读！
- **写**：只允许
  - `/dev/stdout /dev/stderr /dev/null /dev/tty /dev/dtracehelper /dev/autofs_nowait`（CLI 设备通道）
  - `/tmp/claude`、`/private/tmp/claude`
  - `~/.npm/_logs`、`~/.claude/debug`、`~/.claude/statsig`（自己的日志/遥测）
  - `.`（当前工作目录）+ 历史 originalCwd
- **强制 deny 写**（`ydA()`，无论配置如何都写不了）：
  - 全部 5 个 settings 文件（防止改自己的配置）
  - 项目中的 `.gitconfig`、`.gitmodules`、`.bashrc`、`.bash_profile`、`.zshrc`、`.zprofile`、`.profile`、`.ripgreprc`、`.mcp.json`（`Pj1`）
  - 目录：`.git`（其下 hooks/config 单独列）`.vscode` `.idea` `.claude`（其中 `.claude/commands`、`.claude/agents` 显式拒绝）
  - 用内置 ripgrep（vendor 自带的 rg）按 `--iglob` 扫描项目树找出这些文件，排除 node_modules
- `TMPDIR` 映射：`xm8()` 对 `/var/folders/.../T`/`/private/var/.../T` 形态的 TMPDIR 在写白名单中补上父目录，避免编译器写临时文件失败。

**对比默认策略（重要）**：Claude Code 的默认是"**读全开 + 写只允许工作目录**"；而本仓库 Pi 沙箱的默认是"**读只允许工作区（`denyRead:["/"]` + allowRead 白名单）+ 写同样只允许工作区**"——Pi 把"用户数据（home 等）"整体挡在读之外、需显式授权，比 Claude Code 默认更严格。

### 4.4 Linux：bwrap 挂载模型（cli.js `Pm8()` / `AQQ()`，逐行还原）

```
bwrap
  --unshare-pid
  --proc /proc                     # 除非 enableWeakerNestedSandbox
  [网络隔离时:]
    --unshare-net
    --bind <httpSocketPath> <同一路径>      # socat 桥接 socket 绑进沙箱
    --bind <socksSocketPath> …
    --setenv HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/no_proxy…   # 指向代理
    --setenv CLAUDE_CODE_HOST_HTTP_PROXY_PORT=…
    --setenv CLAUDE_CODE_HOST_SOCKS_PROXY_PORT=…
  [文件系统隔离时（Pm8）:]
    --ro-bind / /                   # 根只读（整体基线）
    每个 allowWrite 存在路径 → --bind <path> <path>        # 变成可写
    每个 denyWrite（且位于 allowed 内）→ --ro-bind <path> <path>  # 盖回只读
    每个 denyRead：目录 → --tmpfs <path>；文件 → --ro-bind /dev/null <path>
    （不存在的路径跳过）
  --dev /dev
  -- bash -c <命令>
```

socat 桥：宿主机起两对桥——`socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:<httpSocket>` 与 `TCP-LISTEN:1080...`（`Tm8()`），配合 `--unshare-net` 后沙箱内唯一网络路径就是这两个端口 → Unix socket → 宿主上的 HTTP/SOCKS5 过滤代理。沙箱内命令还带 `CLAUDE_CODE_SANDBOX=1` 环境变量。

Windows（ASRT alpha，0.0.70 README）：专用的 `srt-sandbox` 本地账户 + WFP egress fence（按 SID 拦所有出站，仅放行 loopback 代理端口）+ NTFS ACE 授权/拒绝，`srt-win` 做两跳拉起（`CreateProcessWithLogonW`）。TLS 终止与凭据掩码在 Windows 上有额外机制（schannel 信任库、`windowsTrustCa`）。这个平台分支目前处于 alpha，产品端主要面向 mac/Linux。

### 4.5 Linux 的 seccomp 层（后续版本加强）

CHANGELOG 提到 Linux 沙箱带 `apply-seccomp` helper（"Linux sandbox now ships the apply-seccomp helper in both npm and native builds, restoring unix-socket blocking"）。机制（ASRT README）：外层 bwrap 后再套一层 nested user+PID+mount namespace，`apply-seccomp` 作为内部 PID 1 先用 `prctl()` 安上 BPF 过滤（拦截 `socket(AF_UNIX)`、`io_uring_setup/enter/register`），再 exec 用户命令——把 Unix socket 创建挡在 syscall 层。可配置 `allowUnixSockets`/`allowAllUnixSockets` 放行。

---

## 5. 规则从哪来（与权限系统的一体化）

### 5.1 文件系统规则 ↔ permission rules

`Qj1()` / `Ij1()`：把 `permissions.deny` 里的 rules 转成读的 `denyOnly`；把 `permissions.allow` 转成写的 `allowOnly`，`permissions.deny` 转成 `denyWithinAllow`。即你在权限系统里说"允许读 `src/`、拒绝写 `.env`"，沙箱 OS 层自动长成对应的 Seatbelt/bwrap 规则。（Linux 上 glob 规则会被跳过并打日志："Skipping glob pattern on Linux"。）

### 5.2 网络规则 ↔ `domain:` rules

`im8()`：`permissions.allow` 中以 `domain:` 开头的内容（如 `domain:github.com`）→ 网络 `allowedHosts`；`permissions.deny` 中 `domain:` → `deniedHosts`。如果没有任何 allow 规则，网络默认全弹窗（见 §6）。

### 5.3 网络白名单/交互式询问

v2.0.42 的产品行为：
- 沙箱内**每个新域名首次访问会弹许可询问**（"Do you want to allow this connection?"），允许后**本会话内记住**（CHANGELOG 778："hosts you allow with 'Yes' are now remembered for the rest of the session"）；后续版本还可以持久化到 settings。
- 这也是为什么企业里后来加了 `sandbox.network.strictAllowlist`（2.1.x，"deny non-allowlisted hosts for sandboxed commands without prompting"）和 `allowManagedDomainsOnly`——管理端锁白名单时禁止绕行弹窗。
- macOS 上所有目标流量都过代理（`needsNetworkRestriction: !0` 硬编码），Linux 同样总是网络隔离；`no_proxy` 默认放行 `localhost,127.0.0.1,::1,*.local,.local,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`（本地开发访问不走代理；另给 `GIT_SSH_COMMAND` 设 `nc -X 5 -x localhost:<socks>` 让 git-over-ssh 也走 SOCKS）。

### 5.4 凭据（credentials）与强制 deny

- v2.0.42：没有独立的 credentials 配置块；保护手段是 ① 文件系统强制 deny 写列表（含 `.gitconfig` 等）② 后版本加 `sandbox.credentials`（"block sandboxed commands from reading credential files and secret environment variables"）。
- ASRT 0.0.70 已把 credentials 做成正式配置：`credentials.files[].mode: "deny" | "mask"`、`credentials.envVars[].mode`，mask 模式由 HTTP 代理在 egress 时用真实值替换哨兵值；文件级 mask 仅 Linux 可用（macOS 退回 deny）；支持 `extract` 正则、JWT 解码+claim 级掩码、AWS SigV4 重签名等（详见 `dist/sandbox/sandbox-config.d.ts`）。
- 系统提示里明确告诫 model："do not add `~/.bashrc`, `~/.zshrc`, `~/.ssh/*`, or credential files to the allowlist"。

### 5.5 违规反馈：`<sandbox_violations>`

- macOS 有**实时违规监控**：ASRT 读取系统沙箱违规日志（`log stream --predicate 'process == "sandbox-exec"'`；cli.js 启动时 `"[SandboxManager] Started macOS sandbox log monitor"`），`SandboxViolationStore` 订阅者把最近违规做成 UI 徽标（"last 10 violations"）。
- 命令结束后，把违反记录以 `\n<sandbox_violations>\n...行...\n</sandbox_violations>` 形式拼进 stderr（`annotateStderrWithSandboxFailures`）；上层再把这段 XML 注释从输出里剥掉但保留给模型提示（`sk6`/`cdA`）。
- `ignoreViolations` 配置可以在特定命令匹配时忽略特定路径的违规（防止误报）。

---

## 6. 交互路径汇总

```
模型想跑 bash
 └─ m4A() 判定是否沙箱化（enabled && 非 excluded && 非 dangerouslyDisableSandbox 逃逸）
    ├─ 否 → 直接 host bash（走权限系统逐条许可/规则）
    └─ 是 → am8() wrap
         ├─ macOS: sandbox-exec -p <profile> bash -c 'export 代理env && cmd'
         │          + macOS 违规日志监控 → SandboxViolationStore → UI 徽标
         └─ Linux: bwrap … bash -c cmd  (+socat 桥/代理, 后续版本 +apply-seccomp)
         └─ 沙箱内网络首次访问新域名 → "Do you want to allow this connection?" 弹窗
                  允许 → 会话内记住；拒绝 → 该连接被代理拒绝
         └─ 命令结束 → stderr 追加 <sandbox_violations>…</sandbox_violations>
```

「逃逸」路径：Bash 工具参数 `dangerouslyDisableSandbox: true`；模型被系统提示教导：默认不要用，命令因沙箱失败时再用；`allowUnsandboxedCommands: false`（/sandbox 菜单里叫 **Strict sandbox mode**）则完全禁用该参数。`excludedCommands` 是另一条逃逸（按命令名，不走弹窗）。企业受管策略可锁死这两者并禁用 `--dangerously-skip-permissions`。

---

## 7. 演进时间线（CHANGELOG，选关键条目）

- **2.0.24**：`Sandbox: Releasing a sandbox mode for the BashTool on Linux & Mac` —— 功能正式对外发布（bash 工具专用，仅 mac/linux）。
- 2.1.x 早期：`$TMPDIR` 回归修复（2.1.154 只影响沙箱命令）；`/sandbox` 菜单 UI 迭代、依赖检查告警；去掉 "bash commands will be sandboxed" 横幅。
- **2.1.38**：`Blocked writes to .claude/skills directory in sandbox mode`（强制 deny 列表持续扩充）。
- 2.1.x 中段：`sandbox.enableWeakerNetworkIsolation`（macOS trustd 放行，解决 Go/gh/gcloud TLS 校验）；`sandbox.bwrapPath`/`sandbox.socatPath`（自定义二进制路径）；`allowUnsandboxedCommands`（政策级关掉逃逸口）；`subprocess sandboxing with PID namespace isolation on Linux when CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`；`apply-seccomp` 打包进官方安装。
- **2.1.34 前后**：`sandbox.network.deniedDomains`（白名单内再挖黑名单）；`sandbox.failIfUnavailable`（fail-closed 选项）；`strictAllowlist`（禁弹窗）；`sandbox.filesystem.disabled`（只留网络隔离）；`mode: "mask"` 凭据掩码（Linux/WSL）；Windows alpha（WFP + srt-win）；`allowMachLookup` macOS 生效修复；网络代理大文件上传 TLS 修复。
- 安全修复贯穿始终：`.claude/*` 符号链接绕行 deny-write、auto-allow 绕过危险路径检查（`rm` 指向 `/` 或 `$HOME`）、`dangerouslyDisableSandbox` 免弹窗漏洞等。

---

## 8. 与本仓库 Pi 沙箱的对比

| 维度 | Claude Code（v2.0.42 + ASRT 0.0.70） | Pi（`extensions/sandbox` + ASRT 0.0.70） |
| --- | --- | --- |
| 覆盖对象 | 仅 Bash 工具子进程 | bash 工具 + 直接文件工具（tool_call 拦截层） |
| 底层 | 同一 ASRT：macOS sandbox-exec / Linux bwrap(+seccomp) | 同一 ASRT |
| 默认读 | **全开**（deny 规则挖洞） | 仅工作区 + 系统/工具链 + 临时区（`denyRead:["/"]` + allowRead） |
| 默认写 | 工作目录 + tmp + dev + 自己的日志目录；`~` 下只读 | 工作区 + 临时区；家目录需授权 |
| 强制 deny | 5 个 settings 文件、`.gitconfig` 等 9 个文件、`.git/.vscode/.idea/.claude`(部分) | `.env*`、`*.pem`、`*.key` + 运行时自带 deny（如 `.bashrc` 等） |
| 网络默认 | 全出站走代理 + **新域名逐个弹窗**（会话内记忆）；`no_proxy` 放本地网段 | 域名单（registry/源码托管类）+ `allowLocalBinding`；非白名单直接拒绝，无弹窗 |
| 规则来源 | 复用 permission rules（allow/deny/ask、`domain:`） | 独立 `sandbox.json` 配置 + `/sandbox` 命令管理 |
| 凭据 | 强制 deny 写 + 后加 credentials/mask（代理 egress 替换） | 敏感 env `mode:"deny"` 清除 + 家目录读拒绝 + git 身份 host 侧注入 |
| fail-closed | v2.0.42 静默降级；后加 `failIfUnavailable`/告警 | 一直 fail-closed（init 失败即 blocked，`--no-sandbox` 显式逃逸） |
| 超时/取消 | 无专门设计（产品行为，非沙箱层） | 无隐式超时 + 进程组 TERM→KILL |
| 违规反馈 | macOS 日志监控 + `<sandbox_violations>` 进 stderr + UI 徽标 | 无（运行时日志为主） |
| 企业受管 | 五级 settings，policy 可锁 | 受信任项目可读 `.pi/sandbox.json` |

### 对 Pi 沙箱扩展的启示

- **弹窗式网络询问（ask）**：Claude Code 用"新域名询问 + 会话内记忆"换兼容性；Pi 目前是纯白名单 fail-closed。若日常使用中经常需要临时域名，可考虑类似 ask 模式（结合现有的 `sandbox_authorize_*` 授权流）。
- **强制 deny 列表**：Claude Code 的 `ydA()`（settings 文件、`.gitconfig`、`.claude/*`、`.git/hooks|config`）值得并入 Pi 的 denyWrite 基线——目前 Pi 默认只拒绝 `.env*`/密钥类文件。
- **`<sandbox_violations>` 反馈回路**：把 OS 层 EPERM/代理拒绝转成结构化信息回传给模型，目前 Pi 缺失，是感知沙箱失败原因的关键 UX。
- **credentials.mask**：Pi 目前是 `deny`（干脆看不见）；若要支持"沙箱内需要用到但不想暴露"的 token 场景，ASRT 的 mask + egress 替换是现成方案（仅 Linux 下文件级可用）。
- **产品侧默认值差异**：Claude Code 读全开/写受限，Pi 读也受限；这是有意为之（工作区作为用户数据信任边界），但要在文档/测试里明确这是区别于上游的收紧决策。

---

## 附：进一步阅读

- ASRT 官方开源仓库与 `srt` CLI：`npm i -g @anthropic-ai/sandbox-runtime`（本仓库 node_modules 中 0.0.70 自带完整类型）
- Claude Code 官方沙箱文档（本网络不可达，需代理访问）：`docs.claude.com/en/docs/claude-code/sandboxing`
- 官方工程博客（不可达）：`anthropic.com/engineering/claude-code-sandboxing`（"Beyond Permission Prompts: Making Claude Code More Secure and Autonomous"）
- 本仓库既有设计文档：`docs/sandbox-design.md`（对照阅读）
- 同类产品对比：`docs/grok-build-sandbox.md`（Grok Build 沙箱：整进程 Landlock/Seatbelt + seccomp 子进程网络）
