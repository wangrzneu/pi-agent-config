# Grok Build 的 Sandbox 机制调研

调研目标：弄清 Grok Build（xAI 的编程 agent，`grok` CLI + 云端 IDE）**产品层面**如何使用沙箱，重点是与上一份调研（Claude Code 本地沙箱）和本仓库 `extensions/sandbox`（Pi 沙箱扩展）的对比。

## 来源（全部为一级来源）

| 来源 | 说明 |
| --- | --- |
| `github.com/xai-org/grok-build`（官方开源仓库，Apache-2.0） | 这是 `grok` CLI/TUI 的 **Rust 完整源码**（从 xAI monorepo 定期同步，根目录有 `SOURCE_REV`）。沙箱实现在 `crates/codegen/xai-grok-sandbox/` 独立 crate |
| 仓库内 `docs/user-guide/18-sandbox.md` | 官方产品文档（随源码发布） |
| `docs/user-guide/22-permissions-and-safety.md` | 权限模式官方文档 |
| `crates/codegen/xai-grok-sandbox/src/*.rs` | `lib.rs`、`profiles.rs`、`deny/mod.rs`、`deny/glob.rs`、`child_net.rs`、`hook_write_deny.rs`、`paths.rs`、`types.rs`（全部逐文件阅读） |
| `xai-grok-tools/src/computer/local/terminal.rs`、`xai-grok-tools/src/implementations/grok_build/bash/mod.rs`、`xai-grok-shell/tests/*`、`prod/mc/cli-chat-proxy-types/src/sandbox_types.rs` | 沙箱接线点与云端沙箱 API 类型 |
| `@demicodes/provider-grok-build`（npm） | 第三方适配器，印证 `~/.grok` OAuth 会话与 CLI 交互方式 |

> 说明：官方文档站 docs.x.ai / x.ai 在本网络不可达（代理 allowlist 阻断）。好在 CLI 沙箱的**全部实现与文档都在开源仓库里**，比官网文档更详实。云端托管 IDE（build.grok.com）的沙箱不在开源仓库内（仅有 API 类型线索见 §6）。

---

## 1. 一句话结论

Grok Build CLI 的沙箱是**进程级、一次性、不可逆**的 OS 内核沙箱：在启动时把**整个 `grok` 进程**（含所有工具、MCP、子 bash）用 **Linux Landlock / macOS Seatbelt** 锁住，不是像 Claude Code 那样"每次 bash 命令临时包一层"。默认**关闭**，通过 `--sandbox <profile>` / `GROK_SANDBOX` / 配置文件选择 4 个内置 profile（`workspace` / `devbox` / `read-only` / `strict`），并支持自定义 profile（`deny` 列表由内核强制，macOS 用 Seatbelt regex、Linux 用 bwrap bind-over）。网络限制只在 Linux 上通过 seccomp 拦**子进程**（macOS 无效），Agent 自己的 HTTP（web_search/LLM）永不受影响。

> 与 Claude Code 的对比（核心差异）：**一个"整进程终身边界"，一个"每条命令动态包装"**。Claude Code 的 `Read/Write/Edit` 工具不进沙箱（走权限系统）；Grok Build 由于整进程受限，文件工具天然在边界内。另外 Grok Build 的沙箱是"默认关闭、按需配置"，Claude Code 是"默认开启（新版）"。

---

## 2. 启用与开关

### 2.1 CLI / 配置入口（`xai-grok-pager/src/app/cli.rs`）

```
--sandbox <PROFILE>       # 亦可 env: GROK_SANDBOX=<profile>
[ui] permission_mode     # 权限模式（与沙箱是两回事）
~/.grok/sandbox.toml     # 全局自定义 profile
.grok/sandbox.toml       # 项目自定义 profile（只允许"新增"名字，不能覆盖全局）
requirements.toml        # 受管要求：可强制 profile（优先级最高）
```

Profile 解析顺序（新会话）：`--sandbox` / `GROK_SANDBOX` → 配置里的 `[sandbox] profile` → `off`。受管 `requirements.toml` **钉死** profile：测试证明 `cli_flag_overrides_config_but_not_requirement`（`xai-grok-shell/tests/sandbox_requirements_pin.rs`）——CLI 能压过普通配置，但压不过 requirement。

### 2.2 会话级固化（Grok 独有的设计）

- profile 随会话持久化，**resume 时自动恢复**同一个 profile。
- `--sandbox <profile>` 与已保存的 profile **不一致时直接拒绝**（错误退出），防止回滚会话偷偷放宽/收紧边界（"changing a resumed session's sandbox is a safety footgun"）。要换 profile 就开新会话。

### 2.3 默认与平台支持

- **默认 `off`，完全不受限**（与 Claude Code 新版默认开启相反）。
- 平台：Linux 用 **Landlock（内核 ≥5.13）**；macOS 用 **Seatbelt**。Linux 上 Landlock 不可用（内核太老/缺失）时，内置 profile **打日志后继续运行（无沙箱）**；但**自定义 profile 带 `deny` 时 fail-closed**——无法内核实施就拒绝启动。
- Windows CLI 暂无沙箱。
- 对于普通内置 profile，应用失败是"warn + 继续"；但此时**仍拒绝启用 leader 代理**（见 §4.4），因此不会在无边界状态下把工具委托出去。

---

## 3. 内置 Profile（`profiles.rs` / 官方文档表格）

| Profile | 读 | 写 | 子进程网络 | 场景 |
| --- | --- | --- | --- | --- |
| `off`（默认） | 无限制 | 无限制 | 无限制 | 无沙箱 |
| `workspace` | **全盘可读** | CWD + `~/.grok/` + `/tmp` `/var/tmp`（+macOS temp） | 放行 | 日常开发（推荐） |
| `devbox` | 全盘可读 | 所有顶层目录（除 `/data`、`/proc` `/sys` `/dev`），**包括 home** | 放行 | 一次性开发 VM |
| `read-only` | 全盘可读 | `~/.grok/` + temp | **Linux 上拦（seccomp），macOS 无效** | 代码评审、探索 |
| `strict` | **仅 CWD + 系统路径**（/usr /lib /bin /sbin /etc /dev /proc /sys /tmp /run /var + macOS 的 /System /Library /private + ~/Library + workspace + ~/.grok） | CWD + `~/.grok/` + temp | 同上 | 不可信代码 |

实现要点（`profiles.rs` 逐行可查）：

- 四个 profile 由 `default_read: bool` + `read_only[]` + `read_write[]` 表示。`workspace/devbox/read-only` 的 `default_read: true` → 直接 `allow_path("/", Read)`，即**读全开**；`strict` 是 `default_read: false` + 显式系统路径列表。
- `read_write` 至少含 workspace、`~/.grok/`（`grok_home()`）和 temp 路径（`paths.rs::temp_writable_paths`，识别 `$TMPDIR` 与 macOS `/private/var/folders`）。
- 设备文件单独放行（`DEVICE_FILES`）：`/dev/null /dev/zero /dev/random /dev/urandom /dev/tty /dev/ptmx`（rw）+ 设备目录 `/dev/pts` `/dev/fd`。有个细节：**`/dev/tty` 在无控制终端时 open 出 ENXIO**，会让 nono 的 Landlock 整个规则集 abort——所以 `device_file_openable()` 会跳过这类文件，否则 headless/CI 就是一次静默的沙箱失效（有回归测试）。
- 写路径若还不存在会先 `create_dir_all`（Landlock 需要 apply 时目录存在，目录内新文件则可自由创建）。
- `devbox` 无法用 Landlock `deny_path`（Landlock 没有 deny），所以 `/data` 是**不放进 read_write** 实现的（保持可读但不可写），其 Linux 只读由 bwrap re-exec 的 `--ro-bind /data /data` 兜底；同时刻意不把 `/data` 放进 kernel-deny 集合，避免自定义 profile 继承 devbox 时误伤。

### 3.1 自定义 profile（`~/.grok/sandbox.toml` / `.grok/sandbox.toml`）

```toml
[profiles.project]
extends = "workspace"          # workspace | devbox | read-only | strict（缺省 workspace）
restrict_network = true
read_only = ["/data"]
read_write = ["/tmp/scratch"]
deny = ["/data/shared-secrets", "**/.env", "**/*.pem"]   # 内核强制 读+写/改名 全拦
```

安全约束（值得抄进 Pi 的设计）：

- **项目配置是纯增量的**：只能新增 profile 名，不能覆盖全局已有名字 → 防止恶意仓库"掏空"用户自定义 profile（同名 last-write-wins 会允许 workspace 里定义一个空的 `deny`/宽泛 `read_write` 的 "project" profile 替换用户的）。冲突时用用户全局那份并打警告，`/doctor` 可查。
- 自定义 profile 不能 `extends` 另一个自定义 profile（只能 extends 内置），也不能 `extends = "off"`。
- `devbox` 是保留名（`--sandbox devbox` 永远跑内置，不会被用户 shadow）。

---

## 4. 实现机制（`xai-grok-sandbox` crate）

### 4.1 整体流程（`lib.rs::SandboxManager`）

```
SandboxManager::new(profile, workspace)
  → apply(workspace)                     # 不可逆；一次调用
     1. requires_hook_write_deny? → 准备 ~/.grok/hooks 写保护
     2. load_sandbox_config + resolve_profile(workspace)   # 展开成 read_only/read_write/deny…
     3. Sandbox::support_info()（nono）→ 不支持则告警继续（内置）
     4. capability_set_from_profile()    # 构建 nono CapabilitySet（Landlock/Seatbelt 规则）
     5. deny::effective_deny_paths() + apply_deny_paths/apply_deny_globs
     6. Sandbox::apply(&caps)            # 内核施加，进程终身生效
     7. install()                        # 存全局状态：违规日志、metrics、网络限制开关
  → bwrap_reexec_for_profile()（仅 Linux 且带 deny）  # 若需要 bind-over，先在自己外面再 exec 一次 bwrap
  → 各 spawn 点 pre_exec(install_child_network_filter)  # restrict_network 子进程时
```

底层用 **`nono` crate**——crates.io 可查的第三方库（`nolabs-ai` 发布，描述为 "Capability-based sandboxing library using Landlock (Linux) and Seatbelt (macOS)"），Grok 锁定 `=0.53.0`（当前上游 0.71.x）。`nono::SupportInfo` 决定平台可用性。

- **进程级**：`tokio::fs` 的 in-process 读写同样受 Landlock/Seatbelt 约束 → `read_file`/`search_replace`/`list_dir`/`grep(rg)` 全部覆盖，无需单独工具拦截层。
- **不可逆**：`Sandbox::apply` 之后无法放宽（`Landlock`/`Seatbelt` 都不支持撤销）。文档明确"This means all tool operations are covered"。

### 4.2 macOS：Seatbelt 规则（`deny/mod.rs`、`glob.rs`）

`nono::CapabilitySet::allow_path` 生成宽带规则，之后对开洞路径叠加精确 deny：

- 精确路径 deny（`apply_deny_paths_to_capability_set`）：因为 `default_read` 给了 `(allow file-read* (subpath "/"))` 这种全放行，**后发的 deny 规则按 Seatbelt last-match 语义可能被 allow 反转**——所以：
  - read-deny：发 `(deny file-read* (literal|subpath ...))`
  - write-deny：**光发 `(deny file-write* ...)` 不够**（工作区的 `(allow file-write* (subpath <ws>))` 在后、按 last-match 赢），所以额外对 8 个具体写子动作逐个 deny：`file-write-data/-create/-unlink/-mode/-owner/-flags/-times/-setugid`（注释明说这是按操作实测的，并有 macOS e2e 当契约）。
  - **`/private` firmlink 别名**：`/tmp/x` ↔ `/private/tmp/x`、`/var`、`/etc` 都要成对 deny，否则可从别名绕过。
  - **祖先加固**：对可写根内每个 deny 路径的祖先链也发 `file-write-unlink/-create` deny（防 `mv`/`rm` 换位绕过），并 pin 住父目录。
  - **fail-closed**：路径含控制字符 → 拒绝启动（否则规则静默指向别的路径）；无法表达 → 不 apply（shell 的 `!is_applied` 守卫拒绝启动）。
- glob deny（`glob.rs`，macOS 天然"气密"）：glob → **锚定的 Seatbelt regex `^(root/)(tail)$`**，运行时匹配 → **启动后新建的匹配文件也被拦**。跨平台校验：任何 mac/Linux 会解释不一致的写法（`{}`、`\`、`**` 非独立段、空段、`.`/`..`、`[::]`、`[]` 开头的类）一律**拒绝启动**。支持 `*` `?` `**/` `[abc]` `[!a]`/`[^a]`。相对 glob 锚定 workspace，绝对 glob 用字面前缀。

### 4.3 Linux：Landlock + bwrap bind-over（`lib.rs`、`deny/mod.rs`、`glob.rs`）

- **Landlock 没法 deny 子树**（只有 allow）；所以 read-deny 走 **bwrap re-exec**：启动时若带 deny，`grok` 用 `bwrap_reexec_command_ex` 在自己的**外层再 exec 自己一次**：
  ```
  bwrap --cap-drop ALL --bind / / --ro-bind <deny_write存在的路径> --
        [--bind <祖先 RW> ... --ro-bind <leaf RO> ...]        # hook 写保护 plan
        [--ro-bind <000占位> <deny_read路径> ...]              # read-deny bind-over
        --dev-bind /dev /dev --proc /proc -- grok <原参数>
  ```
  - read-deny：在 `~/.grok/` 下建 `sandbox-blocked.<pid>`/`sandbox-blocked-dir.<pid>` **chmod 000 占位文件**，`--ro-bind` 盖到目标路径 → 读它得到 EPERM。占位文件名带 PID 防并发竞争。
  - deny_write 路径不存在则跳过；read-deny 路径不存在也要 bind（evans malformed…用 `--ro-bind` 盖 `/dev/null` 或占位）。
  - bwrap 内再用 `__GROK_INSIDE_BWRAP=1` 标记自己（防重复 re-exec），并**在 bwrap 内禁用嵌套 userns**（`--disable-userns` 相关逻辑/测试，防 mount 重排）。
  - 环境变量策略见 §5.3。
- **glob deny 在 Linux 是 best-effort（文档诚实标注）**：mount namespace 无法运行时 glob → 启动时用 `ignore`（ripgrep 库）遍历扩展成具体路径再 bind-over。有上限（`DENY_GLOB_CAPS`：深度 64、命中 4096、访问 2_000_000），**超限拒绝启动**而非少拦；**启动后新建的匹配文件不覆盖**（文档明确建议 Linux 上用精确路径）。符号链接同时掩掉逻辑路径与 canonical 目标。
- 权限错误（EACCES）可跳过（OS 本来就拒绝），其它遍历错误 fail-closed。

### 4.4 网络限制：seccomp（`child_net.rs`）——仅 Linux 子进程

- **filter A（child network filter）**：pre_exec 装在 bash/终端子进程上，拦 `connect/bind/sendto/sendmsg/listen/accept/accept4` → 全部 EPERM。`NO_NEW_PRIVS` 前置。
- **filter B（namespace lockdown filter）**：进程级（TSYNC 装到所有线程），拦 `unshare`、`setns`、`clone(CLONE_NEWNS/NEWUSER/NEWPID/NEWNET/…)` → EPERM；`clone3` → **ENOSYS**（classic BPF 无法读指针参数，直接让 libc 回退 legacy clone，恶意 clone3 也不能建命名空间）。目的：**阻止沙箱内进程自己再建命名空间逃逸**。装于 bwrap re-exec 之后 / apply 时（`hook_write_deny.rs::ensure_namespace_lockdown`）。
- **macOS 网络限制是 no-op**（文档+代码）：Seatbelt profile 不拦 outbound（Agent 自身 web_search/LLM 要联网），子进程也没有 seccomp 等价物 → `read-only`/`strict` 在 macOS 上"子进程网络不受限"。这一点在文档表格里加了下标说明。
- Agent 内置工具（web_search、web_fetch、LLM API）的 in-process HTTP **永不受影响**——只有 spawn 出的 bash 子进程被 seccomp 拦。Claude Code 的等价物是"所有出站走代理 + 域名策略"，Grok 是"一刀切禁子进程网络（Linux）"。

### 4.5 leader/共享会话的沙箱拒绝（fail-closed 的第二种形态）

`test_leader_sandbox_confinement.rs`：请求了非 `off` profile 时，`connect_or_spawn` 直接抛 `SandboxConfinement(profile)` 错误——**不连接 leader、不 spawn leader**。文档：agent 以 in-process 运行（不通过共享 leader），`grok workspace start/restart/resume` 不可用（pause/stop/status 可用）。这是"整进程沙箱"模型与 Claude Code "多会话共享 leader"模型的直接冲突点，他们的解法是：有沙箱就不共享。

### 4.6 hook 写保护（`hook_write_deny.rs`）——Grok 独有

非 devbox 的内置 profile 下，`~/.grok/hooks/`、`~/.grok/hooks-paths` 及其绝对路径目标被**内核写保护（仍可读）**：权限来源（hook 是能执行任意命令的全局配置）必须是 agent 写不了的。细节：

- 第一次启动时创建真实空 `hooks/` 目录和空 `hooks-paths` 文件（绝不建符号链接）；`$GROK_HOME` 是符号链接、或者 hooks-paths 里的条目带符号链接 → **拒绝启动**（防重定向）。
- 父目录 pin 住（祖先 RW bind 在前、leaf RO bind 在后，且不让 `/` 被 RW bind，有专门测试断言顺序）。
- 拒绝硬链接文件作为 hook 源。Linux bwrap 内禁嵌套 userns 来防止 mount 重排。
- Claude/Cursor 的全局 hook 不适于此保护（另由兼容设置 gate）。

---

## 5. 配套防线

### 5.1 权限系统（`xai-grok-workspace/src/permission/*`）——与沙箱正交

- 模式：`default(ask)` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`（产品名 `--always-approve`，别名 `--yolo`）。
- 规则：allow / ask / deny；deny 优先于 allow、优先于 always-approve。有 `claude_settings.rs`（**兼容读取 Claude Code 的 settings**）、`auto_mode/`（LLM 分类器）、`bash_command_splitting.rs`、`exec_risk.rs`、`gate_preflight.rs`。
- 文档："Deny always wins over allow and over always-approve's normal pass-through"。
- 与 Claude Code 相同：**沙箱管 OS 边界，权限系统管"要不要问"**。

### 5.2 事件日志与遥测（`types.rs`、`logging.rs`）

`~/.grok/sandbox-events.jsonl`：`ProfileApplied`（profile/workspace/platform/enforced/restrict_network/read_write/read_only/deny 全量上下文）、`ApplyFailed`、`FsViolation`（operation+target）、`NetViolation`、`BypassGranted/Denied`。metrics：fs/net violations、bypasses granted/denied。**这个"结构化违规事件"直接对应 Claude Code 的 `<sandbox_violations>` 思路**，但更完整（Claude Code 只把违规拼进 stderr）。

### 5.3 子进程环境变量策略（`shell_env_policy.rs` + 文档附表）

`[shell_environment_policy]`：`inherit = all|core|none`、`ignore_default_excludes`（内置 `*KEY*`/`*SECRET*`/`*TOKEN*` 名模式，默认 true=不拦）、`exclude[]`、`include_only[]`、`set{}`。顺序：inherit → 默认排除 → exclude → set → include_only。大小写不敏感 glob。默认 no-op（全继承）。注意默认 `ignore_default_excludes = true`——即**默认不主动滤密钥环境变量**，与 Claude Code 的 credentials deny 不同；要开在配置里写明。

---

## 6. 云端（托管）沙箱——开源仓库里的线索

`prod/mc/cli-chat-proxy-types/src/sandbox_types.rs` 是 chat-proxy（云会话代理）的沙箱 API 类型：

- `SandboxMode`：`SANDBOX_MODE_AGENT` / `SANDBOX_MODE_WORKSPACE_SERVER`。
- `POST /v1/sandbox/sessions/fork`：`sourceSandboxId` + `copies`；`snapshot_bucket` 字段**出于 CWE-284 反序列化但服务端必须忽略**（防用户指定 GCS bucket 越权，有专门测试）。
- 云沙箱有快照（snapshot bucket → GCS）、fork 语义——即**托管环境的沙箱是容器/VM 级 + 快照支持**，与 CLI 的本机 Landlock/Seatbelt 是两个层面。CLI 的 `grok workspace`/leader 等概念也与云会话（chat sandbox）连接。

也就是说：**Grok Build 产品里的"sandbox"字眼至少指两层**——① CLI 本机进程沙箱（本调研主角，开源）；② 云端 workspace 沙箱（容器级、快照、fork，封闭源码，只有 API 类型公开）。Claude Code 也有同样的云层（Web/cloud 中的 container sandbox），两者本地层与云层的分工一致。

---

## 7. 与本仓库 Pi 沙箱的对比

| 维度 | Grok Build CLI（`xai-grok-sandbox`） | Claude Code（v2.0.42 + ASRT） | Pi（`extensions/sandbox` + ASRT） |
| --- | --- | --- | --- |
| 施加对象 | **整个 grok 进程**（启动时一次，不可逆） | 每条 bash 命令临时 wrap | 每个 bash 子进程 wrap + 直接文件工具 tool_call 拦截 |
| 平台原语 | Linux Landlock(+bwrap 补 deny) / macOS Seatbelt；Linux 子网 seccomp | sandbox-exec(Seatbelt)/bwrap(+socat+seccomp) | 同 Claude Code（ASRT） |
| 默认 | `off`（完全关闭） | 新版默认开启（v2.0.42 缺省 false） | `enabled: true`（fail-closed，init 失败即 blocked） |
| 默认读 | 全盘可读（workspace/read-only）；strict 才限 CWD+系统路径 | 全盘可读（默认） | **仅 workspace + 系统/临时区**（`denyRead:/`） |
| 默认写 | CWD + `~/.grok/` + temp | CWD + `/tmp/claude` + dev/log 路径 | CWD + 临时区 + 沙箱缓存根 |
| 拒绝列表 | `deny`（自定义 profile；内核强制 读+写/改名，mac 气密 / linux 尽力） | 强制 deny 写（settings/`.gitconfig`/`.claude/*` 等 9 文件+目录） | `.env*`/`*.pem`/`*.key` + 系统强制 deny |
| 网络模型 | 内置 profile 全网放行；`restrict_network`=**禁子进程网络（Linux seccomp，macOS 无效）**；Agent 自身联网不受影响 | 全部走 HTTP/SOCKS5 代理 + 域名规则/弹窗 | 域名单白名单 + `allowLocalBinding` |
| 超时/取消 | Bash 工具自身 timeout/后台（与沙箱无关） | 无专门 | 无隐式超时 + 进程组 TERM→KILL |
| 环境变量 | `[shell_environment_policy]`：core/none/exclude/include_only/set；默认 no-op | credentials deny/mask（后来版本）| 敏感 env `mode:"deny"` 清除 + git 身份 host 注入 |
| 违规反馈 | `~/.grok/sandbox-events.jsonl`（结构化事件 + metrics + Bypass 计数） | `<sandbox_violations>` 拼 stderr + macOS 违规监控 UI | 无（runtime 日志为主） |
| 会话固化 | profile 随会话保存，resume 不可改 | 无（沙箱是全局设置） | 无（session 级 grants 内存态） |
| 受管 | `requirements.toml` 可钉死 profile（压过 CLI flag） | 企业 managed-settings 可锁 | 受信任项目 `.pi/sandbox.json` |

### 对本仓库 Pi 沙箱扩展的具体启示

1. **整进程沙箱 vs 每命令包装，值得重新权衡**。Grok 用 Landlock/Seatbelt 包住整个进程一次，天然覆盖 `read_file`/`grep`/子 bash，无需 Pi 现在"OS 层 + tool_call 拦截层"两套机制保持一致的复杂度。代价是不可逆、且不能像 Pi 这样按命令动态授权（Pi 的 `wrapWithSandbox` 每次合并 session grants，正是为了 macOS Seatbelt 按调用生成 profile）。Pi 如果也想走整进程路线，`@anthropic-ai/sandbox-runtime` 目前是 per-exec 模型，不直接支持；但可以参照 Grok 把**"整进程只读基线 + 每次命令动态放宽一段"**做成两层。
2. **glob deny 的跨平台"气密性"处理**：Grok 的 `validate_deny_glob` 在两个平台上拒绝一切解释不一致的写法（宁可启动失败也不静默降级），macOS 用锚定 regex（覆盖启动后新建文件）、Linux 用启动时扩展+硬上限。Pi 当前的 `denyWrite` 只有精确路径；若加 glob 支持，照抄这个"同一语法、两平台验证、fail-closed"模式。
3. **`deny` 的"读+写/改名"全拦语义**（`mv secret x && cat x` 绕行必须有专门的 write sub-action deny）——Pi 的路径授权目前拦的是工具层，OS 层 `denyWrite` 只拦写；若用 ASRT 的 `denyRead`+`denyWrite` 组合不完全等价于 Grok 的 `deny`（Grok 连 rename/unlink 都拦）。
4. **违规事件要结构化**：Grok 的 `sandbox-events.jsonl`（事件+metrics+bypass 计数）比 Claude Code 的 stderr 注释更好调试，可做 `/sandbox` 的"最近事件"面板。
5. **hook 源写保护**：Pi 的 `~/.pi/agent/.../skills/hooks` 类似物（agent 资源目录）应像 Grok 的 `~/.grok/hooks/` 一样内核写保护，防止 agent 自己改写自己的钩子。
6. **环境变量策略默认值差异值得注意**：Grok 默认 `ignore_default_excludes=true`（不滤密钥），Pi 默认滤 `*KEY*/*TOKEN*` 类 + 显式敏感清单——Pi 更严，保持。
7. **网络一刀切 vs 域名策略**：Grok 的 `restrict_network` 太粗糙（全禁或全开，连 `no_proxy` 都没有；macOS 还无效）；Claude Code/Pi 的代理+域名策略精度更高。若 Pi 需要"禁网"profile，可引入 seccomp 子进程过滤作为**第二道**，而不是替代。

---

## 附：进一步阅读

- 官方开源仓库：`github.com/xai-org/grok-build`（Apache-2.0；`SOURCE_REV` 标注对应 monorepo commit）
- 沙箱 crate：`crates/codegen/xai-grok-sandbox/`；用户指南 `docs/user-guide/18-sandbox.md`、`22-permissions-and-safety.md`
- 依赖：`nono` crate（Landlock/Seatbelt 封装，本地无源码，从 Cargo.toml 锁的文件版本）
- 官方 CLI 安装：`curl -fsSL https://x.ai/cli/install.sh | bash`
- 本仓库已有文档：`docs/claude-code-sandbox.md`（上一份调研）、`docs/sandbox-design.md`、`docs/security.md`
