# Sandbox development environments and Kubernetes access

This document defines the planned development-environment system for
[`extensions/sandbox`](../extensions/sandbox). It extends the Process sandbox
with composable Go, Python, Node.js, pnpm, kubectl, and AWS CLI profiles,
dynamic installation, bounded storage, and session-scoped Kubernetes context
grants.

The design preserves the existing sandbox principles: fail closed, keep user
credentials out of child processes, and use exact filesystem grants.

## Goals

A user can select any compatible combination at sandbox startup:

- Go
- Python
- Node.js
- pnpm
- kubectl
- AWS CLI (local resolution only)

Missing runtimes may be installed dynamically, except for the AWS CLI, which
resolves only already installed local binaries. Runtime objects are shared
read-only across projects; mutable dependencies and virtual environments are
project-scoped. Kubernetes credentials remain on the host and only explicitly
selected contexts are reachable from the sandbox.

Example:

```bash
pi --sandbox-env go@1.26.6,python@3.13.9,node@26.5.0,pnpm@10.33.0,kubectl@1.32.3,aws
```

## Current state

The Process sandbox inherits Pi's environment and `PATH`, then redirects common
language and package-manager caches into a process-scoped sandbox directory.
System and Homebrew toolchains often work because their roots are baseline
readable, while runtimes under `~/.pyenv`, `~/.asdf`, `~/.nvm`, Conda, and
similar home directories are normally denied.

The startup selector, local and managed resolvers, immutable store, restricted
tar.gz installer, and Kubernetes capability broker are implemented. Official
manifests cover Go, Node.js, pnpm, and kubectl for supported Darwin/Linux and
arm64/x64 targets; the pinned Python catalog uses checksum-verified Astral
`python-build-standalone` archives for `3.11.11`, `3.12.9`, and `3.13.9`. The
AWS CLI profile resolves local installations only and has no managed catalog
(see Profile behavior). Runtime leases and automatic quota/retention LRU
pruning are active. `/sandbox env` provides status, listing, and pruning
commands.

## Domain model

A **Profile** identifies one selected capability and exact version, for example
`go@1.26.6` or `pnpm@10.33.0`.

A **Selection** is the set of Profiles requested for one sandbox session. A
language may occur at most once. pnpm requires a compatible Node.js Profile.

An **Environment Plan** is the fully resolved result for one Process sandbox
session: runtime objects, environment variables, ordered binary directories,
and exact read roots.

A **Runtime Object** is an immutable, content-addressed installation for one
host platform. Runtime Objects are shared read-only across projects.

A **Cluster Grant** authorizes one Kubernetes context for the current session.
The context, rather than only the cluster, is the grant unit because it combines
cluster, credential identity, and default namespace.

## Configuration

Configuration keeps the existing precedence: built-in defaults, global
`sandbox.json`, then trusted project `.pi/sandbox.json`. CLI values override
configuration. Interactive selection overrides configured defaults only for the
current initialization.

```json
{
  "developmentEnvironments": {
    "promptOnStart": true,
    "selected": ["go", "python", "node", "pnpm", "kubectl", "aws"],
    "install": {
      "mode": "ask",
      "maxSize": "5g",
      "retentionDays": 30
    },
    "profiles": {
      "go": { "version": "1.26.6", "source": "auto" },
      "python": { "version": "3.13.9", "source": "auto" },
      "node": { "version": "26.5.0", "source": "auto" },
      "pnpm": { "version": "10.33.0", "storeScope": "project" },
      "kubectl": { "version": "1.32.3", "source": "auto" },
      "aws": { "source": "auto" }
    }
  },
  "kubernetes": {
    "promptOnStart": true,
    "defaultAccess": "observe",
    "defaultNamespaces": "context",
    "persistContextSelection": false,
    "credentialMode": "host-broker"
  }
}
```

`install.mode` is `never`, `ask`, or `auto`. In a non-interactive mode, `ask`
behaves as `never`; startup must not silently download software when no approval
channel exists.

## Startup selection

In TUI mode the extension shows one multi-select screen before sandbox runtime
initialization. It displays the host platform, exact versions, source (`local`
or `managed`), whether an object is installed, and estimated download size. The
selection can contain all five profiles simultaneously.

Version hints come from trusted project files:

- Go: `go.mod` and its `toolchain` directive
- Python: `.python-version` and `requires-python`
- Node.js: `.nvmrc`, `.node-version`, and `package.json#engines.node`
- pnpm: `package.json#packageManager`, with `pnpm-workspace.yaml` as a usage hint
- kubectl: explicit configuration, with an optional recommendation based on a
  selected API server version
- AWS CLI: explicit configuration only; there is no project file hint

A range or mutable label such as `latest` must resolve to an exact version and
content digest before installation.

## Runtime resolution

The resolver first tries an already active/local runtime without sourcing a
login shell. It canonicalizes the runtime root and grants that exact root
read-only to sandboxed shell children. If no acceptable local runtime is
available, it may use a managed object for the host platform.

No resolver executes `.zshrc`, `nvm use`, `conda activate`, `pyenv init`, or
`asdf init`, and no resolver imports an entire login-shell environment.

## Content-addressed store

The managed root lives under the Pi agent cache and is not a direct-tool read
root:

```text
~/.pi/agent/cache/sandbox/
├── toolchains/
│   ├── objects/sha256/<digest>/
│   └── refs/<platform>/<profile>/<version>
├── package-cache/
├── staging/
├── locks/
└── usage.json
```

Installation uses a dedicated restricted installer: resolve a trusted manifest,
show source/size, acquire a version lock, download into staging, verify digest
or package integrity, reject unsafe archive entries, validate version and
platform, then atomically publish the object. The compressed archive is removed
after publication. Sandboxed commands receive exact read grants for published
Runtime Object paths.

Sessions lease every object they use. Garbage collection never deletes active,
pinned, or installing objects. When the configured quota is exceeded it removes
expired staging data, unused package cache, and finally old unreferenced
runtimes in LRU order. Cleanup touches only this managed
root and never invokes global container/image pruning.

## Environment composition

Adapters return data; one composer owns conflict checking and `PATH` ordering.
Selected profile bin directories precede the inherited host `PATH`.

Environment merge order is: Pi command environment, selected profile values,
git identity, sandbox-owned cache/temp/config overrides, then ASRT credential
filtering. Adapters cannot override sandbox-owned `GOPATH`, cache roots,
`PIP_CONFIG_FILE`, or temporary directories. Conflicting values fail instead of
silently depending on adapter order.

## Profile behavior

### Go

Process probes an explicit/local `go` with `GOENV=off go env -json GOROOT
GOVERSION`, canonicalizes `GOROOT`, and avoids user Go configuration. Managed
host objects use the same sandbox-owned `GOCACHE`, `GOMODCACHE`, and `GOPATH`.

### Python

Process probes an already-active `VIRTUAL_ENV` first, then `PATH`, and falls
back to a managed interpreter. It never executes a project-controlled `.venv`
during trusted startup, so project code and project `PATH` shims cannot run in
the trusted resolution process. Probing uses isolated mode (`-I -S`). It clears
`PYTHONPATH` and `PYTHONHOME`, enables `PYTHONNOUSERSITE`, and retains
`PIP_CONFIG_FILE=/dev/null`.

### Node.js

Process resolves an explicit/current Node installation without invoking nvm or
shell startup, otherwise it uses a managed host-platform object.

### pnpm

pnpm requires exactly one compatible Node Profile. The installer downloads the
exact npm package, verifies `dist.integrity`, stores it immutably, and creates a
session shim that invokes its `pnpm.cjs` with the selected Node binary. It never
runs `npm install -g pnpm` and does not rely on an inherited Corepack home.

The default package-store scope is project-local for isolation. A global mode
may trade stronger cross-project isolation for more deduplication; it must keep
store integrity checking enabled and be documented as a weaker cache boundary.

### kubectl

The kubectl binary is an ordinary Tool Profile: local or managed on the host.
Selecting the binary grants no cluster access. Official checksums are required. A server-version hint may
recommend a version, but resolution remains exact and follows Kubernetes
version-skew rules.

### AWS CLI

The AWS CLI is an ordinary local Tool Profile: the trusted startup probes an
already installed `aws` with `--version`, parses the `aws-cli/<version>` banner,
and grants only the binary's canonical directory read-only. There is no managed
catalog entry: AWS publishes GPG signatures instead of digest sidecars for its
zip archives, and macOS ships a `.pkg` the restricted installer cannot extract.
Because managed installation requires verified official digests, requesting a
managed AWS CLI object fails closed instead of downloading unverifiable
artifacts. Users install the CLI themselves (Homebrew or the official
installer) and select `aws` for local resolution.

Credentials stay host-side: `~/.aws` remains unreadable and `AWS_*` environment
variables are stripped from the sandbox, and `aws` remains in the default
`hostExec.commands` list, so plain `aws` commands are still promoted to the host
after approval. Running `aws` inside the sandbox requires an explicit
credential route such as the mask + TLS-termination + SigV4 re-signing design
in [`sandbox-credential-clis.md`](sandbox-credential-clis.md) and removing `aws`
from `hostExec.commands`.

## Kubernetes context grants

The trusted host reads normal kubeconfig sources and presents metadata only:
context, cluster, API server, namespace, authentication kind, exec-helper
command name, and source file. It never renders token, client key, certificate
contents, refresh token, or exec-helper output. A context is not persisted as an
active grant across sessions.

The user selects zero or more contexts. Each grant can use `observe` or `rbac`
access and an optional namespace allowlist. `observe` permits discovery and
approved get/list/watch/log requests while blocking mutations and dangerous
subresources such as exec, attach, port-forward, and proxy. Kubernetes RBAC
remains authoritative; the local policy is additional restriction.

### Credential broker

Real kubeconfig and credentials stay on the host:

```text
sandbox kubectl
    -> sanitized session kubeconfig
    -> TLS capability gateway
    -> host kubectl proxy / credential transport for one context
    -> selected API server
```

Each context has an independent random session capability and fixed upstream.
The gateway is not a CONNECT/general proxy, cannot select an arbitrary upstream,
rejects cross-context capabilities and unapproved redirects, and closes active
connections on revoke. The gateway listens on loopback only.

The sandbox kubeconfig contains only gateway endpoints, an ephemeral gateway CA,
and opaque capabilities. It is mounted read-only and removed on reload, revoke,
or shutdown. `KUBECONFIG` points only to this file, so unselected host contexts
are invisible.

A kubeconfig exec helper is not run while listing contexts. Before starting a
broker that needs `aws`, `gcloud`, `kubelogin`, or another helper, the extension
shows the exact helper invocation and obtains a session host-execution approval.
Helper output never enters the sandbox or model context.

## Lifecycle and failure behavior

Startup loads trusted config, obtains the Selection, resolves versions, asks to
install missing objects, provisions the Environment Plan, selects Kubernetes
contexts, approves required host credential helpers, starts brokers, writes the
sanitized kubeconfig, and initializes host ASRT.

A required runtime failure blocks shell startup. A failed Cluster Grant fails
closed for that context and exposes no kubeconfig entry; unrelated local shell
work may continue unless configuration explicitly marks the context required.
A declined installation returns to the selector in TUI or blocks a required
non-interactive Selection.

Shutdown stops process groups, stops all Kubernetes brokers and gateways,
closes granted connections, deletes capabilities and sanitized config, releases
runtime leases, resets ASRT, and removes process-temporary data on quit.
Managed runtime objects remain for reuse.

## Commands and status

Planned commands:

```text
/sandbox env
/sandbox env select
/sandbox env list
/sandbox env prune
/sandbox env prune --all-unused
/sandbox kube
/sandbox kube select
/sandbox kube revoke <context>
/sandbox kube revoke-all
```

`/sandbox` reports the Process sandbox policy, exact profiles/platform/source,
managed-store usage/quota, and active Kubernetes grants without credential
material.

## Module shape

```text
extensions/sandbox/
├── environments/
│   ├── types.ts
│   ├── selection.ts
│   ├── selector.ts
│   ├── composer.ts
│   ├── local-resolver.ts
│   ├── managed-resolver.ts
│   ├── process-resolver.ts
│   ├── installer.ts
│   ├── artifact-catalog.ts
│   ├── archive-extractor.mjs
│   ├── restricted-installer.ts
│   ├── store.ts
│   └── session-controller.ts
├── kubernetes/
│   ├── controller.ts
│   ├── context-source.ts
│   ├── context-selection-store.ts
│   ├── session-access.ts
│   ├── sanitized-kubeconfig.ts
│   ├── proxy-broker.ts
│   ├── capability-gateway.ts
│   └── tls-material.ts
├── config.ts
├── process.ts
├── path-gate.ts
├── path-authorization.ts
├── host-escape.ts
├── git-identity.ts
├── status.ts
└── index.ts
```

The external seams remain small: resolve/provision/compose one Environment Plan,
and grant/revoke/stop the Kubernetes broker. Language and tool adapters remain
internal to those modules.

## Verification

Tests cover configuration precedence and trust, profile parsing and conflicts,
deterministic `PATH`, runtime probing, archive integrity and safe extraction,
concurrent installation, atomic publication, leases/quota/LRU, Python venv
persistence, pnpm/Node compatibility, kubeconfig secret redaction, delayed
exec-helper approval, capability isolation, access/namespace policy, revoke
behavior, and Process integration.

End-to-end verification runs all selected tools in one sandbox:

```bash
go version
python --version
node --version
pnpm --version
kubectl version --client
aws --version
```

and verifies selected Kubernetes contexts while proving an unselected context
and all raw host credentials remain inaccessible.

## Delivery sequence

Completed:

1. Configuration, startup Selection, Environment Plan, composer, and managed
   content-addressed store foundations.
2. Process adapters for Go, Python, Node.js, pnpm, and kubectl.
3. Safe tar.gz extraction, official-manifest integrity verification, and dynamic
   Go, Node.js, pnpm, and kubectl installation.
4. Process Kubernetes metadata selection, TLS capability gateway, host
   `kubectl proxy`, sanitized kubeconfig, and revoke lifecycle.
5. Immutable objects, session leases, quota/retention LRU pruning, and
   sandbox-restricted archive extraction.
6. Pinned relocatable Python catalog (`3.11.11`/`3.12.9`/`3.13.9`) with
   cross-platform manifest coverage.
7. Environment and Kubernetes session controllers extracted from the extension
   entrypoint.
8. Failure-injection and recovery regression tests: installer HTTP/oversize
   and redirect, gateway non-loopback upstream, and store concurrent publish
   and corrupted/dangling reference recovery.
9. AWS CLI Tool Profile with local-only resolution and a fail-closed managed
   rejection (no official digest sidecar; zip/pkg archives unsupported).

Remaining:

- Continue cross-platform (darwin-x64/linux-x64) catalog coverage and
  failure-injection integration hardening.

Recommended defaults are install mode `ask`, globally shared
read-only Runtime Objects, project Python/pnpm state, no Kubernetes context grant,
`observe` access, context-default namespace, non-persistent context selection,
and host-broker credentials.
