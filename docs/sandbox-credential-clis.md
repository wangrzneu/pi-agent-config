# 沙箱内运行“凭据型 CLI”（aws / gh / gcloud …）的方案

> 背景问题：像 `aws` 这类 CLI 启动时需要读 `~/.aws/credentials`、`~/.aws/config`、`~/.aws/sso/cache/*.json`，而 Pi 沙箱扩展的默认策略是 `denyRead:["/"]` + 仅放行 workspace 与系统路径，`~/.aws` 不可读；三个 AWS 环境变量还被 `credentials.envVars` 以 `deny` 移除。结果：**沙箱里的 `aws` 目前无法认证**。
>
> 结论先行（有 0.0.70 源码支撑）：**比 FUSE 更好的官方方案是 ASRT 的“凭据掩码 + egress 注入/重签名”机制**——`credentials` 的 `mask` 模式 + `network.tlsTerminate` + SigV4 重签名（`aws-sigv4.js`、`credential-aws-pairs.js`）。它**不需要**放开 `~/.aws` 的读权限，真凭据从不进入沙箱进程（进程只见掩码哨兵值），由代理在 TLS 终止后替换/重签。

---

## 1. 为什么 `aws` 在现有沙箱里无法工作

| 障碍 | 现状 |
| --- | --- |
| `~/.aws/credentials` 读 | `denyRead:["/"]`，`allowRead` 不含 home → 读取被 OS 拒绝 |
| `AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN` | `config.ts:52` 的 `SENSITIVE_ENV_VARS`，`mode:"deny"` → 从子进程环境**移除** |
| 网络 | `allowedDomains` 无 AWS 端点（sts/ec2/s3/sso…）→ 连接被代理拒绝 |
| SSO `~/.aws/sso/cache/*.json` | 同 `~/.aws` 不可读，且 SSO token 是 JWT |

直接可用的临时缓解（治标）：把 `~/.aws/config`（region/profile/SSO start-url，**无密钥**）加入 `allowRead`，`~/.aws/credentials` 与 sso cache 仍 deny。`aws` 至少能到“缺失凭据”的错误而不是“文件不可读”，但对真正使用无济于事。

---

## 2. 推荐的正式方案：mask + tlsTerminate + SigV4 重签名（ASRT 一等的 AWS 支持）

### 2.1 机制（0.0.70 源码已验证）

```
1) 凭据掩码（credential-mask-*）
   ~/.aws/credentials 读 → mode:"mask"（Linux 全文件/整段掩码；macOS 文件级退化 deny → 用 env 掩码）
   AWS_* 环境变量        → mode:"mask"（whole-value 或 extract 正则/ JWT maskClaims）
   → 沙箱进程看到的 key/secret/token 都是哨兵值（sentinel），真实值登记在 SentinelRegistry

2) egress 注入（credential-sentinel.js substituteInHeaders / body）
   代理出口到 injectHosts 命中域时，把哨兵替换回真实值
   → 但 Authorization/签名是 HMAC(真实 secret)，光换头修不了签名

3) TLS 终止（tls-terminate-proxy.js + mitm-ca.js + mitm-leaf.js）
   HTTPS CONNECT 在代理内终止，能看见明文请求 → 才能做头部/体替换与重签
   沙箱内客户端信任：CA_TRUST_VARS（sandbox-utils.js:375-396）
     NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE
     PIP_CERT / GIT_SSL_CAINFO / **AWS_CA_BUNDLE** / CARGO_HTTP_CAINFO / DENO_CERT
     CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE / NIX_SSL_CERT_FILE
   → aws CLI v2（botocore）读 REQUESTS_CA_BUNDLE/AWS_CA_BUNDLE，信任代理叶证书

4) SigV4 重签名（aws-sigv4.js + credential-aws-pairs.js）
   代理检测到 masked AKID 的签名请求 → 用真实 secret 重算签名
   覆盖：header-sig、presigned URL（query 签名）、streaming（aws-chunked）、
         body literal hash（≤64MiB 缓冲重算，超限 403 fail-closed）
   触发门：请求签名引用了 awsPairs 配对中的 fake AKID（exact match）
```

### 2.2 硬性前置（源码约束）

- `sandbox-config.js:1127-1140`：**只要有 masked 凭据，就必须配 `network.tlsTerminate`**，否则配置校验直接报错（除非 `credentials.allowPlaintextInject: true` 显式接受明文注入——不推荐）。
- `sandbox-manager.js:326-330`：SigV4 重签**只在 TLS 终止路径**执行（真实签名不允许走明文）。
- 因此：**该方案 = mask + tlsTerminate 一揽子**，两者缺一不可。

### 2.3 配置示例（可放进 Pi 扩展的 sandbox.json）

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": [
      "sts.amazonaws.com", "*.amazonaws.com",
      "sso.amazonaws.com", "sso.us-east-1.amazonaws.com",
      "identitycenter.amazonaws.com", "*.identitycenter.amazonaws.com"
    ],
    "tlsTerminate": {
      "excludeDomains": ["*.amazonaws.com"]      // 见下方说明
    }
  },
  "credentials": {
    "envVars": [
      { "name": "AWS_ACCESS_KEY_ID",     "mode": "mask" },
      { "name": "AWS_SECRET_ACCESS_KEY", "mode": "mask" },
      { "name": "AWS_SESSION_TOKEN",     "mode": "mask" },
      { "name": "AWS_PROFILE",           "mode": "mask" }   // 也可不掩码
    ],
    "awsPairs": [
      {
        "accessKeyIdVar": "AWS_ACCESS_KEY_ID",
        "secretAccessKeyVar": "AWS_SECRET_ACCESS_KEY",
        "sessionTokenVar": "AWS_SESSION_TOKEN"
      }
    ],
    "sigv4": { "streaming": "deny", "presigned": "deny", "sigv4a": "deny" }
  },
  "filesystem": {
    "denyRead": ["/"],
    "allowRead": [".", "/private/tmp", "/var/folders"],   // 不放开 ~/.aws
    "allowWrite": [".", "/private/tmp"]
  }
}
```

说明：
- `awsPairs` 把三个掩码变量**配对**成一组凭据，代理才知道拿哪个 secret 重签哪个 AKID。
- `injectHosts` 缺省 = `network.allowedDomains`，即只往放行域注入；**建议显式列出**（`"injectHosts": ["sts.amazonaws.com", "*.amazonaws.com"]`）。
- `excludeDomains` 若包含 `*.amazonaws.com`，则这些域名**不终止**（透明隧道，客户端自己完成 TLS 握手并用 AWS_CA_BUNDLE 验证真实证书）——**好处是避免大流量过 MITM 的性能/信任风险**；坏处是此时代理看不到明文 → 无法做注入/重签。所以 `excludeDomains` 与“注入/重签”互斥：**要重签就**不能**把相关域名放进 excludeDomains**。取舍：
  - 需要重签（IAM key 认证）→ 不排除；
  - 只想给 SSO/bearer 或只允许网络 → 可 exclude 掉大流量域（curl 下载 s3 大文件时）。
- macOS 上：`~/.aws/credentials` 文件级 mask **退化 deny**（README + credential-mask-files 注释），所以 macOS 用户用 **env 掩码**这条路径即可；AKID/SECRET 由 `aws configure` 写进文件也行，但文件读会被 deny → 还是得先 `aws configure export-credentials` 或手动设 env。
- tlsTerminate 需要 CA：缺省自动生成临时 CA（随进程生命周期）；建议配 `caCertPath/caKeyPath` 持久化，减少每次启动重新信任的麻烦（沙箱内信任走 CA_TRUST_VARS，无需用户手动信任）。

### 2.4 代价与风险

| 项 | 说明 |
| --- | --- |
| MITM | 全部 AWS 流量经代理解密重签。信任边界从“内核”延伸到**代理进程**（宿主上 ASRT 进程）——它本就持有全部凭据，可接受；但请确认 ASRT 信任边界与宿主同权 |
| 性能 | TLS 终止 + 重签是大请求路径上的 CPU 开销；大文件上传建议 `excludeDomains` + 客户端自带证书校验 |
| 能力矩阵 | `sigv4` 对 streaming/presigned/sigv4a 默认 deny：某些形态（大文件分段、STS presigned URL 下载）会 403，需按需开 |
| 复杂度 | 配置项多、概念多；这是“完整替换沙箱内 aws 认证”的代价 |

---

## 3. 更简单的替代路径（按成本排序）

### 3.1 宿主提升（沿用设计文档 Decision 6 的思路，成本最低）

把 `aws`（以及 gcloud/gh 等）划入 `hostExec` 宿主执行：`matchHostExecCommand` 检测到命令含 `aws` 前缀 → **确认后交给宿主 BashOperations 执行**，输出回传。完全绕开沙箱，真凭据只在宿主侧，复用现有 git push 的授权体验。

- 优点：零新配置、零 MITM、零沙箱内凭据。
- 缺点：每条命令都要一次“是否放行到宿主”的确认（可用“本次会话允许 aws 前缀”白名单缓解）；交互式命令（`aws sso login` 要开浏览器）天然适合宿主执行。
- 适合：低频管理命令、sso login、一次性操作。**Pi 当前架构下最实用的一条**。

### 3.2 客户端自带凭据路径（不需要代理注入，但需要放弃“凭据不进沙箱”原则）

把真实凭据放进沙箱：要么 `allowRead ~/.aws/credentials`，要么 shell 里注入真实 env。**违背扩展设计原则 5（凭据不进子进程）**，且一个被注入的 bash 可 `cat` 出凭据。仅在信任环境 + 低频取的临时解。

### 3.3 凭据端点（credential_process / AWS_CONTAINER_CREDENTIALS_FULL_URI）

AWS SDK 支持从自定义 HTTP 端点拿凭据（EC2 metadata 同款协议）。可以让宿主起一个小 HTTP server（只监听 loopback）输出真凭据，沙箱内 `aws` 通过 `AWS_CONTAINER_CREDENTIALS_FULL_URI` 拉取。

- 优点：无需 MITM/TLS 终止，签名由沙箱内的 aws 用**真实** secret 计算（代理不再关心签名）。
- 缺点：真凭据**进入沙箱进程**（SDK 拿到真实 key 才签得了名），等于 3.2 的仪式版；但 endpoint 是 loopback + token，注入风险小，且不需要放开文件读。
- 适合：SSO 刷新、多 profile、需要“aws 内部完成握手”但不想 MITM 的场景。

### 3.4 组合建议（现实工作流）

- 日常 `aws s3 ls / describe / run`：**mask + tlsTerminate + awsPairs**（§2.3 配置），一劳永逸，凭据永不进沙箱。
- `aws sso login`（需要浏览器、写 sso cache）：**宿主提升**最省心（3.1）。
- 大文件 s3 传输：`excludeDomains` 排除大流量域 或 宿主提升。

---

## 4. 同类 CLI 推广

同一个 `credentials` 机制可直接覆盖其他“需要读 ~ 凭据”的工具：

| 工具 | 凭据位置 | 方案 |
| --- | --- | --- |
| `gh` | `~/.config/gh/hosts.yml`（含 token）| `credentials.files[{path:"~/.config/gh/hosts.yml", mode:"mask", extract:<token 正则>}]` + `injectHosts:["api.github.com","*.github.com"]`；或宿主提升 |
| `gcloud` | `~/.config/gcloud/application_default_credentials.json` | files mask（JSON 内 `client_secret`/`refresh_token` 用 extract 掩码）+ `injectHosts` + gcloud 自带 `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` 信任 |
| `npm`/`pnpm` | `~/.npmrc`（`//registry.npmjs.org/:_authToken=`）| files mask + injectHosts npm registry 域名（现有 `npm_config_userconfig:/dev/null` 已挡了默认文件，需要时改走 mask） |
| ssh git | `~/.ssh/*` | 维持现状：宿主侧 Keychain/ssh-agent 提升（git push 现有 Decision 6） |
| 通用 | 任何 `~/.config/*/token` | `credentials.files` 的 `extract` 正则只掩码 token 值，其余配置原样可读 |

核心不变式：**沙箱内永远只见哨兵值/掩码值，真凭据只在宿主代理的 egress 注入或宿主直接执行**。

---

## 5. 与 FUSE 方案的对比

| | FUSE 门 | credentials mask + tlsTerminate |
| --- | --- | --- |
| 拦截面 | 整个 `~`（所有文件） | 声明的文件/变量（精确） |
| 真凭据是否进沙箱 | 否（授权后进程读真实文件 → 是，会进） | **从不**（哨兵值直到出口才还原/重签） |
| 平台 | macOS 全局不可行 / Linux 复杂 | **全平台**（macOS 用 env 掩码） |
| 内核 vs 用户态 | 用户态守护进程 | 代理（用户态）但凭据不落地沙箱 |
| 对 aws 的适配 | 无（TOCTOU/EXDEV/性能） | **一等公民**（aws-sigv4 + awsPairs + CA_TRUST_VARS） |
| 实现成本 | 新守护进程 + 状态机 | **纯配置**（extensions/sandbox/sandbox.json） |

结论：对“aws 这类依赖 ~ 凭据的 CLI”，**mask+tlsTerminate 是官方、可配置、最低成本的正解**；FUSE 在“凭据不落地”这一点上反而更差（授权后进程直接读到真文件）。

---

## 6. 通用化：不针对某个 CLI，而是覆盖所有“需要读 ~ 凭据”的工具

上面 aws 的特例配置可以推广成一套**通用方法**。先看清问题的本质是两个正交子问题：

1. **“去哪儿”**（非机密）：工具要知道 region/profile/registry/endpoint —— 这些只在 `~/.aws/config`、`~/.config/gh` 等**非机密部分**；
2. **“我是谁”**（机密）：token/secret/key —— 这才是要藏的部分。

两件事可以用不同的通用手段分别解决，不必逐工具写 extract 正则。

### 6.1 通用路线 A：脱敏副本 + 默认注入（推荐，工作量小、全平台）

思路：**不拦原文，给“读”一个脱敏副本**。

```
1) 扫描 ~ 下的凭据候选文件（固定清单 + 常见路径模式，如 ~/.aws/*, ~/.config/*/config*.yml, ~/.npmrc, .netrc）
2) 对每个文件做「通用脱敏」：按 key 名模式（/token|secret|password|_authToken|client_secret/i）或高熵值启发式，把机密字段替换成哨兵
3) 脱敏副本写到沙箱可读路径（如 SANDBOX_TEMP_ROOT/config-mirror/），并把该目录 grant 进 allowRead
4) 出口：SentinelRegistry 默认 injectHosts=allowedDomains（credential-mask-files.js:178 / credential-mask-env.js:74-80），代理在 TLS 终止路径把哨兵还原成真值
```

- 好处：**无需逐个工具配置 extract 正则**；非机密部分原样保留（工具能看懂格式）；aws 之外的所有 bearer/OAuth 工具（gh、gcloud、npm、docker registry 等）一次性覆盖。
- macOS 关键点：文件级 mask 在 macOS **退化为 deny**（SBPL 无法重定向读，credential-mask-files.js:20-21）。**但“脱敏副本”不是 mask，是把改写后的内容写到另一个路径** —— 这不受该限制影响，全平台可用。
- 签名型（HMAC）工具只有 aws 这类需要 re-sign，仍然用 awsPairs/SigV4（§2）专项处理；其余都是 bearer/header 替换，通用路线 A 即可。

### 6.2 通用路线 B：宿主提升 + 会话级模式记忆（零新组件，先落地）

把现有 Design Decision 6（git push 宿主执行）泛化成「凭据需要型命令分类器」：

- 识别特征：命令前缀命中已知凭据 CLI（aws/gh/gcloud/docker/npm publish/ssh…），**或**命令的参数/环境涉及已知凭据路径。
- 行为：首次弹确认，**本会话记住该命令模式**（一次同意 → 整个会话该类命令都宿主执行）。
- 优点：零 MITM、零脱敏器、凭据完全不进沙箱；
- 代价：这些命令**不在沙箱内**（失去 OS 隔离），但和 git push 是同一种“高风险操作提升”的既有形态。

### 6.3 通用路线 C（Linux 长期）：seccomp user-notification —— “逐调用授权”

真正“通用到内核”的做法：`SECCOMP_FILTER_FLAG_NEW_LISTENER` 装上后，**任何进程、任何文件**的 `openat` 都可以被父进程（Pi 扩展）拦截、问用户、放行/拒绝，且是**运行时**（进程已经起来了也能授权）。

- 这才是“FUSE 门”的通用内核版——但没有用户态文件系统信任面；
- 代价：实现成本高（syscall 转发、路径解析、fd 转交），Linux only；建议只做 PoC。

### 6.4 三路线对比

| | A 脱敏副本+注入 | B 宿主提升 | C seccomp user-notif |
| --- | --- | --- | --- |
| 覆盖 | 所有 bearer/OAuth 工具 | 所有命令（白名单式） | 所有文件/进程 |
| 凭据进沙箱 | 否（哨兵值） | 否（宿主执行） | 遏制（授权后才可见真值） |
| 平台 | 全平台 | 全平台 | Linux only |
| 实现成本 | 中（脱敏器 + 副本） | 低（分类器复用） | 高（内核对接） |
| 运行时授权 | 否（预先脱敏） | 否（整命令提升） | **是** |

### 6.5 落地建议

1. **先做 B**（小改，立刻可用）：扩展 `matchHostExecCommand` 分类器（`hostExec.commands` 配置 + 会话记忆）；
2. **再补 A**（大收益）：脱敏副本组件，一次性覆盖 gh/gcloud/npm/docker 等，aws 走 awsPairs 专项；
3. **Linux 上可论证 C** 作为“逐调用授权”的终极形态；
4. FUSE 方案在 §5 已判否：通用性不如 A/B/C，凭据落地问题也更差。

---

## 附：关键源码依据（node_modules/@anthropic-ai/sandbox-runtime@0.0.70）

- `sandbox-config.js:1127-1140`：mask 必须配合 tlsTerminate（校验期强制）
- `sandbox-manager.js:321-330`：注入/重签只在 TLS 终止路径；明文注入需 allowPlaintextInject 显式放弃
- `aws-sigv4.js`：header/presigned/streaming/literal-hash 四种形态；64MiB 缓冲上限
- `credential-aws-pairs.js`：mask 凭据配对与重签触发
- `credential-mask-env.js` / `credential-mask-files.js`：whole-value / extract / JWT maskClaims；文件 mask macOS 退化 deny
- `credential-sentinel.js:170-178`：`substituteInHeaders`，injectHosts 缺省 = allowedDomains
- `sandbox-utils.js:375-396`（CA_TRUST_VARS）：`AWS_CA_BUNDLE` 等 12 个信任 env 变量
- `mitm-ca.js`：信任包（MITM CA + 宿主根证书）写入子进程可读路径
- 扩展现状：`extensions/sandbox/config.ts:52-61`（SENSITIVE_ENV_VARS 含 AWS 三个，mode deny）、`config.ts:121-123`
