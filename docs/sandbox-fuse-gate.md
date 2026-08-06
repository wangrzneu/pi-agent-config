# FUSE 拦截 ~/ 访问 + 授权后放行 —— 可行性分析

> 背景问题：Pi 沙箱扩展（`extensions/sandbox`，基于 `@anthropic-ai/sandbox-runtime`）当前对家目录 `~` 的访问策略是"默认拒绝读、`sandbox_authorize_read/write` 显式授权后才可访问"。用户想知道：能否改用 **FUSE** 在文件系统层拦截对 `~` 的访问，在**明确授权后**放行/继续访问？
>
> 结论先行：**技术可行，但强烈不建议在 macOS 上做；Linux 上"把 FUSE 透传文件系统绑进 bwrap 挂载命名空间"是一个自洽但复杂度/收益失衡的方案。** 现有 Seatbelt/bwrap 机制已经实现了同样的语义，且更安全、更简单。真正的缺口（长生命周期进程的运行时授权）更适合用 seccomp user-notification 或"保持逐命令重新包装"解决。

---

## 1. 背景：现在是怎么拦截 `~` 的

| 层 | 当前机制（`extensions/sandbox`） | 特点 |
| --- | --- | --- |
| 直接工具（read/grep/find/ls/write/edit） | `tool_call` 拦截器 + `SandboxPathAuthorization`（canonical 路径检查） | 进程内决策，可运行时授权 |
| shell 子进程（bash / `!`） | `wrapWithSandbox()` **每条命令**用 ASRT 重新包一层（macOS 每次生成 Seatbelt profile；Linux 每次 bwrap re-exec），本次命令的 OS 白名单 = 基线 + 当前 session grants | 授权以"命令"为粒度 |

注意：session grants（`sandbox_authorize_*` 的授权）会**在每次 `wrapWithSandbox` 时合并进 OS 层的 allow 列表**（`process.ts:56` 的 `commandConfig?.()`）。所以对"逐条命令"的工作流，**授权已经像 FUSE 门一样"授权后就继续放行"了**——每次新命令都带着已授权的路径。

FUSE 门真正能补的，只有这一个缺口：

> **单条长生命周期进程**（例如 `dev server`、`--detached` 后台任务）在启动时其沙箱边界就已固定；如果它运行中途才需要读 `~/.config/...` 或 `~/.ssh/...`，目前做不到"运行中授权"。FUSE 门（或 seccomp user-notif）能在进程运行期间按需放行。

---

## 2. FUSE 方案的形态

### 2.1 核心思路

写一个"**策略透传文件系统**"（policy pass-through FS）：挂一个 FUSE 文件系统覆盖 `~`，把真实家目录搬到后面；所有对 `~` 的打开/读/写先经过 FUSE 守护进程：

```
对 ~ 的 syscall
   → VFS → FUSE 挂载点（守护进程收到 lookup/open/getattr/read/write）
   → 策略判定：
       基线允许或已在授权缓存 → 透传到真实目录
       未授权            → EPERM / 触发 Pi 授权提示（复用 sandbox_authorize_read 流程）
       用户同意          → 写入会话级授权缓存，此后放行
```

授权回路：FUSE daemon（宿主上可信进程）→ IPC 到 Pi 扩展 → 弹授权 UI → 回填缓存。授权只存内存、随会话失效——与现状一致。

### 2.2 现成组件

| 组件 | 说明 | 平台 |
| --- | --- | --- |
| **cgofuse**（github.com/billziss-gh/cgofuse） | Go 跨平台 FUSE 库，macOS 走 cgo+（macFUSE 或 fuse-t）、Linux 走 libfuse 2/3 | 全平台 |
| **fuse-t**（github.com/macos-fuse-t/fuse-t） | macOS **无 kext** 的 FUSE：用户态把 FUSE 协议转成 **NFS v4 本地服务**，让 macOS 挂一个网络卷 | macOS |
| macFUSE（osxfuse 后继） | 传统 kext 方案，安装需用户/系统批准，已不被苹果鼓励 | macOS |
| libfuse3 + `passthrough_fh` | Linux 官方透传示例，可作起点 | Linux |

---

## 3. 关键判断：为什么 macOS 上基本不可行

### 3.1 macOS 没有"每进程挂载命名空间"

FUSE 挂载是**用户级、全局可见**的。macOS 不存在 Linux 那种"把挂载点只放进某个进程的 mount namespace"的能力。也就是说：**FUSE 挂在 `~` 上，挡的不只是沙箱里的 agent，而是你这个用户的全部进程**——finder、终端、VS Code、系统守护进程全部走同一道门。你不可能做到"只拦 Pi 的 bash，不拦你自己的编辑器"。

> 对比：现在用的 Seatbelt 是**内核级、精确到进程**的（`sandbox-exec` 只对该进程树生效）。FUSE 在这个维度上是**全面退化**。

### 3.2 正确原语已经存在

macOS 上"拦截 `~` + 显式授权"的内核实锤就是 **Seatbelt**（`/usr/bin/sandbox-exec`，ASRT 正在用）。它：
- 按进程限定（不会波及其他应用）；
- 内核强制（进程树内无绕过，包括 `sudo`、`/usr/bin/sandbox-exec` 之外的工具）；
- 支持 `(deny file-read* (subpath ...))` + `(allow ...)` 逐条规则，动态 profile 每次生成，**天然支持"授权合并进下次调用"**（现状）。

FUSE 能提供的"运行时授权"在 macOS 上另有更轻的替代（见 §5.3 ESF），没必要引入 FUSE。

### 3.3 fuse-t 的语义代价

fuse-t 用 **NFS v4 本地服务**模拟 FUSE（免 kext），代价是：
- 依赖一个后台 NFS 服务进程 + 首次安装/批准；
- NFS 语义与本地 APFS 有细微差异（xattr、`chmod/owner`、硬链接、`mmap` 行为、大小写等），而 `~` 上跑着 git、ssh、各种配置工具，对语义很敏感；
- 元数据/性能损耗（每个文件操作过一层用户态 NFS 转换）；
- 挂载失败/守护进程被杀时，家目录"消失"——故障模式比"拒绝"更严重（fail-open 或挂死都不可接受）。

结论：**macOS 上不要用 FUSE。** 需要的两个能力（内核级拦截 + 授权后放行）Seatbelt 逐命令重包装已经满足。

---

## 4. Linux 上：可以，但要想清楚值不值

Linux 是唯一能做出"每进程 FUSE 门"的地方，因为 **bwrap 挂载命名空间**可以只对沙箱进程树生效：

```
bwrap --unshare-user --bind /mnt/fuse-home /home/you  ... bash
                                    ↑ FUSE 守护进程由宿主（可信）持有
```

- 只对沙箱树可见：宿主和其他进程看到的仍是真实 `~`（把真实目录挪到 e.g. `/home/.real-you`，FUSE 挂载在原 `~` 路径）。**范围问题解决了**——这正是 macOS 做不到、Linux 能做到的形态。
- 守护进程决策独立于沙箱内进程：沙箱内无法篡改判定。
- 实时授权：进程运行中也能放行（解决 §1 的缺口）。

但要注意的硬伤：

| 问题 | 说明 |
| --- | --- |
| **用户态信任面** | FUSE 是用户态守护进程 + `/dev/fuse` 交互；守护进程崩溃/被 kill → 家目录不可用；守护进程被攻破 = 门被拆。比内核 Seatbelt/bwrap 弱一个数量级 |
| **TOCTOU 竞态** | 路径判定与真正访问之间存在时间窗（与 Seastbelt 目录规则相同的固有问题，但 FUSE 额外引入用户态往返） |
| **性能** | 每次 stat/open/read 都过用户态 + 网络不该有但守护进程内多一次上下文切换；`~` 很大（含各工具 cache/config），全部拦截开销明显 |
| **跨设备语义** | FUSE 挂载是独立挂载点 → `~` 与 workspace 之间 `mv`/`ln` 会变 **EXDEV**，破坏 git/worktree 等跨目录操作 |
| **授权粒度决定的实现复杂度** | 要精准"路径→决定"，FUSE 守护进程需要维护 inode→完整路径映射（cgofuse 透传通常这么干），加 canonical 化、符号链接目标校验；这是一整套有攻击面的状态机 |

**什么时候值得做 Linux FUSE 门**：只有当"运行中授权"是硬需求（例如长期后台任务必须中途读 `~/.netrc`/ssh-agent socket），且接受上述代价。**不值得做**：仅为了复刻现状语义——现状 `wrapWithSandbox` 逐命令合并 grants，已等效满足"授权后继续访问"。

---

## 5. 替代机制（达到目的的更优路径）

### 5.1 Linux：seccomp user notification（最贴合"运行时授权"）

`SECCOMP_FILTER_FLAG_NEW_LISTENER`（内核文档 `Documentation/userspace-api/seccomp_filter.rst`）：
- 对**指定进程树**（无特权，`SECCOMP_USER_NOTIF` + `prctl(NO_NEW_PRIVS)`）装过滤器，把 `openat`/`openat2` 等 syscall 转发给**宿主上的 supervisor**（Pi 扩展）；
- supervisor 解析路径 → 授权判定 → 通知内核放行/拒绝（`SECCOMP_IOCTL_NOTIF_SEND`），还能用 `pidfd_getfd` 代开文件描述符；
- **按进程、免 root、运行时、可交互**——正是 FUSE 门的语义，但留在内核层，无用户态文件系统信任面。

代价：实现复杂（每 syscall 的路径获取、fd 转交、性能），路径解析要小心符号链接/`..`。适合作为 PoC 评估，而不是立刻投产。

### 5.2 Linux：fanotify 权限事件（`FAN_OPEN_PERM` / `FAN_CLASS_CONTENT`）

内核级"授权事件"机制（AV 同款）：可以在打开前问用户态并允许/拒绝。**但**：创建 fanotify 组需要 `CAP_SYS_ADMIN`（需要 root 守护进程）。作为个人开发机要个 root daemon 不划算；bwrap/userns 内也无法满足该能力要求。

### 5.3 macOS：Endpoint Security Framework（ESF）

macOS 系统扩展（`ES_EVENT_TYPE_AUTH_OPEN` 等）能在 VFS 层做"授权判定"（AV/EDR 同款）。但要求：应用需签名 + 系统扩展用户批准（或 MDM 部署）——比 Seatbelt 重得多，且对 CLI 工具过度。Seatbelt 就是这个场景的正确工具。

### 5.4 不彻底的"门"：沿用现状 + 微调

现状差距只在"长生命周期进程"上。三个轻量改进即可覆盖大部分诉求，无需 FUSE：
1. **保持逐命令重新包装**（已实现）——授权对后续命令自动生效；
2. 对 `--detached`/后台任务,启动时**预载** session grants（把当前授权与被授权路径一起固化进该任务第一次 wrap），后台任务需要新授权时由 Pi 提示后在**下一次** wrap 生效；
3. 需要"运行中授权"的特定工具（如 git push 走 SSH），沿用现状的 **host 提升** 路径（Keychain/网络在宿主侧处理），正是设计文档 Decision 6 的做法。

### 5.5 ASRT credentials mask/deny（针对"特定敏感文件"）

如果目标只是拦住 `~/.ssh`、`~/.npmrc` 这类**已知敏感文件**（而不是整个 `~`），ASRT 的 `credentials.{files,envVars}`（`deny`/`mask`）已经是官方提供的、内核层+代理层的组合：`deny` 挡住读取，`mask` 在 egress 时用真实值替换哨兵。不引入新挂载面。（本扩展已配置 `credentials.envVars` deny 敏感 token。）

---

## 6. 对比总表

| 方案 | 生效范围 | 运行时授权 | 需要 root/批准 | 强度 | 复杂度 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| 现状（Seatbelt/bwrap 逐命令） | 进程树 | 命令粒度 | 无 | 内核 | 低（已实现） | ✅ 继续用 |
| **FUSE 门（macOS）** | **全用户所有进程** | 有 | macFUSE kext/fuse-t 批准 | 用户态 | 高 | ❌ 不做 |
| **FUSE 门（Linux, bwrap 命名空间内）** | 仅沙箱树 | 有 | 无（需 /dev/fuse 可写） | 用户态 | 高 | ⚠️ 仅当"运行中授权"成硬需求 |
| seccomp user-notif（Linux） | 指定进程树 | **有（精确）** | 无 | 内核 | 中高 | ✅ 值得 PoC |
| fanotify 权限事件（Linux） | 挂载点/组 | 有 | **CAP_SYS_ADMIN** | 内核 | 中 | ⚠️ 需 root daemon，不划算 |
| ESF（macOS） | 系统扩展 | 有 | 签名+用户批准 | 内核 | 高 | ❌ 对 CLI 过重 |
| credentials deny/mask（现状可用） | 特定文件/env | 无（预设） | 无 | 内核+代理 | 低 | ✅ 针对敏感文件的默认答案 |

---

## 7. 结论与建议

1. **不要为 macOS 引入 FUSE。** 现有 Seatbelt 已经是"按进程 + 内核级 + 授权并入下次调用"的正确实现；FUSE 在 macOS 上是全局拦截（不可接受），还引入 kext/NFS 语义风险。
2. **Linux 上 FUSE 门是自洽方案，但供需错配**——它解决"长生命周期进程的运行时授权"，而这个诉求目前很边缘（Pi 的 bash 是逐命令、后台任务可预载 grants、ssh 走 host 提升）。若将来出现强需求，优先评估 **seccomp user-notification** 原型（无 root、内核级、不新增用户态文件系统信任面）。
3. **短期低成本改进**（无需 FUSE）：给 `--detached` / 长时间后台命令的**首次包装预载 session grants**，并把"新授权对运行中进程生效"记录为已知限制（`readme`/`sandbox.md`）——这覆盖了 FUSE 门 90% 的实用价值。
4. 对"拦截 `~` 的特定敏感文件"，继续用 **ASRT `credentials` deny/mask**（已实现 envVars 部分，可扩展 files）。

---

> 追问“那 aws 这类依赖 ~ 文件的 CLI 怎么办？”→ 完整方案见 [`sandbox-credential-clis.md`](sandbox-credential-clis.md)：ASRT 的 credentials mask + TLS 终止 + SigV4 重签名，是比 FUSE 更好的正解（凭据从不落沙箱）。

## 附：已验证的关键事实

- cgofuse：Go 跨平台 FUSE 库（macOS cgo+macFUSE，Linux libfuse2/3）——github.com/billziss-gh/cgofuse README。
- fuse-t：macOS 免 kext，用户态把 FUSE 协议转 NFS v4 本地服务，macFUSE API 兼容——github.com/macos-fuse-t/fuse-t README。
- seccomp user notification：无特权、按进程、supervisor 可代开 fd——内核 `Documentation/userspace-api/seccomp_filter.rst`。
- 本机为 macOS 26.5.1，当前未安装任何 FUSE；Pi 扩展 `process.ts` 确认逐命令 `wrapWithSandbox(..., commandConfig?.())`。
- ASRT 0.0.70 `credentials.{files,envVars}` schema 已支持 `deny`/`mask`（见 `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.d.ts`）。
- fanotify 权限事件需要 `CAP_SYS_ADMIN`（man 7 fanotify；本网络下 man7.org 不可达，此条属常识性事实，实施前请以 Linux 手册复核）。
