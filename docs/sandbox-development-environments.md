# Sandbox development environments and Kubernetes access

This document defines the planned development-environment system for
[`extensions/sandbox`](../extensions/sandbox). It extends the existing Process
and Apple Container backends with composable Go, Python, Node.js, pnpm, and
kubectl profiles, dynamic installation, bounded storage, and session-scoped
Kubernetes context grants.

The design preserves the existing sandbox principles: fail closed, keep user
credentials out of child processes, use exact filesystem grants, and never
silently downgrade an explicitly requested backend.

## Goals

A user can select any compatible combination at sandbox startup:

- Go
- Python
- Node.js
- pnpm
- kubectl

Both Process and Apple Container backends must support the same user-facing
selection. Missing runtimes may be installed dynamically. Runtime objects are
shared read-only across projects; mutable dependencies and virtual
environments are project-scoped. Kubernetes credentials remain on the host and
only explicitly selected contexts are reachable from the sandbox.

Example:

```bash
pi --sandbox-mode apple-container \
  --sandbox-env go@1.24.2,python@3.13.2,node@22.14.0,pnpm@10.6.0,kubectl@1.32.3
```

## Current state

The Process backend inherits Pi's environment and `PATH`, then redirects common
language and package-manager caches into a process-scoped sandbox directory.
System and Homebrew toolchains often work because their roots are baseline
readable, while runtimes under `~/.pyenv`, `~/.asdf`, `~/.nvm`, Conda, and
similar home directories are normally denied.

The Apple Container backend uses a fixed Linux/arm64 Debian-slim/glibc image
containing Node.js for the guest runner, ASRT, bash, git, curl, and related
support tools. Selectable runtimes are mounted read-only from the managed,
content-addressed store. A macOS runtime or virtual environment is never
executed in the Linux guest.

The startup selector, local and managed resolvers, immutable store, restricted
tar.gz installer, and Kubernetes capability broker are implemented. Official
manifests cover Go, Node.js, pnpm, and kubectl for supported Darwin/Linux and
arm64/x64 targets; the pinned Python catalog uses checksum-verified Astral
`python-build-standalone` archives for `3.11.11`, `3.12.9`, and `3.13.2`.
Runtime leases and automatic
quota/retention LRU pruning are active. Apple projects receive a persistent
trusted-bootstrap Python venv and isolated pnpm store, and `/sandbox env`
provides status, listing, and pruning commands.

## Domain model

A **Profile** identifies one selected capability and exact version, for example
`go@1.24.2` or `pnpm@10.6.0`.

A **Selection** is the set of Profiles requested for one sandbox session. A
language may occur at most once. pnpm requires a compatible Node.js Profile.

An **Environment Plan** is the backend-specific, fully resolved result: runtime
objects, environment variables, ordered binary directories, mounts, persistent
directories, and trusted bootstrap actions.

A **Runtime Object** is an immutable, content-addressed installation for one
platform. Runtime Objects are shared read-only across projects.

A **Project Environment** is mutable state keyed by canonical project identity
and Runtime Object digest, such as a Linux Python virtual environment.

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
    "selected": ["go", "python", "node", "pnpm", "kubectl"],
    "install": {
      "mode": "ask",
      "maxSize": "5g",
      "retentionDays": 30
    },
    "profiles": {
      "go": { "version": "1.24.2", "source": "auto" },
      "python": { "version": "3.13.2", "source": "auto" },
      "node": { "version": "22.14.0", "source": "auto" },
      "pnpm": { "version": "10.6.0", "storeScope": "project" },
      "kubectl": { "version": "1.32.3", "source": "auto" }
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
initialization. It displays the selected backend/platform, exact versions,
source (`local` or `managed`), whether an object is installed, and estimated
download size. The selection can contain all five profiles simultaneously.

Version hints come from trusted project files:

- Go: `go.mod` and its `toolchain` directive
- Python: `.python-version` and `requires-python`
- Node.js: `.nvmrc`, `.node-version`, and `package.json#engines.node`
- pnpm: `package.json#packageManager`, with `pnpm-workspace.yaml` as a usage hint
- kubectl: explicit configuration, with an optional recommendation based on a
  selected API server version

A range or mutable label such as `latest` must resolve to an exact version and
content digest before installation.

## Backend semantics

### Process

The Process resolver first tries an already active/local runtime without
sourcing a login shell. It canonicalizes the runtime root and grants that exact
root read-only to sandboxed shell children. If no acceptable local runtime is
available, it may use a managed object for the host platform.

No resolver executes `.zshrc`, `nvm use`, `conda activate`, `pyenv init`, or
`asdf init`, and no resolver imports an entire login-shell environment.

### Apple Container

The Apple backend uses Linux/arm64 Runtime Objects. Host macOS binaries and
virtual environments are never mounted as executable guest environments. The
selected objects are mounted read-only under `/opt/pi-toolchains` or
`/opt/pi-tools`; mutable project state is mounted under `/var/pi-env`.

The existing transactional workspace, guest ASRT policy, proxy-only network,
and root-read-only container remain in force.

`auto` may fall back from Apple Container to Process only when the complete
Selection can be satisfied by Process. Forced `apple-container` fails closed.
Neither mode ever falls back to an unsandboxed shell.

## Content-addressed store

The managed root lives under the Pi agent cache and is not a direct-tool read
root:

```text
~/.pi/agent/cache/sandbox/
├── toolchains/
│   ├── objects/sha256/<digest>/
│   └── refs/<platform>/<profile>/<version>
├── environments/<project-hash>/<profile>/<runtime-digest>/
├── package-cache/
├── staging/
├── locks/
└── usage.json
```

Installation uses a dedicated restricted installer: resolve a trusted manifest,
show source/size, acquire a version lock, download into staging, verify digest
or package integrity, reject unsafe archive entries, validate version and
platform, then atomically publish the object. The compressed archive is removed
after publication. Normal sandbox commands receive only a read-only Runtime
Object mount.

Sessions lease every object they use. Garbage collection never deletes active,
pinned, or installing objects. When the configured quota is exceeded it removes
expired staging data, unused package cache, stale project environments, and
finally old unreferenced runtimes in LRU order. Cleanup touches only this managed
root and never invokes global container/image pruning.

## Environment composition

Adapters return data; one composer owns conflict checking and `PATH` ordering.
The effective Apple guest order is:

```text
/opt/pi-shims
/var/pi-env/python/bin
/opt/pi-toolchains/go/<version>/bin
/opt/pi-toolchains/node/<version>/bin
/opt/pi-toolchains/python/<version>/bin
/opt/pi-tools/kubectl/<version>
<base guest path>
```

Environment merge order is: Pi command environment, selected profile values,
git identity, sandbox-owned cache/temp/config overrides, then ASRT credential
filtering. Adapters cannot override sandbox-owned `GOPATH`, cache roots,
`PIP_CONFIG_FILE`, or temporary directories. Conflicting values fail instead of
silently depending on adapter order.

## Profile behavior

### Go

Process probes an explicit/local `go` with `GOENV=off go env -json GOROOT
GOVERSION`, canonicalizes `GOROOT`, and avoids user Go configuration. Apple
mounts a verified Linux Go distribution read-only. Both use sandbox-owned
`GOCACHE`, `GOMODCACHE`, and `GOPATH`.

### Python

Process probes an already-active `VIRTUAL_ENV` first, then `PATH`, and falls
back to a managed interpreter. It never executes a project-controlled `.venv`
during trusted startup, so project code and project `PATH` shims cannot run in
the trusted resolution process (project venvs are instead created by the Apple
guest bootstrap below). Probing uses isolated mode (`-I -S`). It clears
`PYTHONPATH` and `PYTHONHOME`, enables `PYTHONNOUSERSITE`, and retains
`PIP_CONFIG_FILE=/dev/null`.

Apple mounts a shared read-only Python runtime and creates a project-scoped venv
under `/var/pi-env/python`. A trusted fixed guest bootstrap creates the venv
without network or project-code execution. Dependencies remain project-scoped.
A glibc/Debian-slim bootstrap image is preferred over Alpine/musl for portable
CPython artifacts and binary-wheel compatibility.

### Node.js

Process resolves an explicit/current Node installation without invoking nvm or
shell startup, otherwise it uses a managed host-platform object. Apple mounts a
verified Linux Node distribution read-only.

The Node binary needed internally by `guest-runner.mjs` is placed under
`/opt/pi-runner` and excluded from the user command `PATH`, so it cannot
accidentally satisfy a selected Node version.

### pnpm

pnpm requires exactly one compatible Node Profile. The installer downloads the
exact npm package, verifies `dist.integrity`, stores it immutably, and creates a
session shim that invokes its `pnpm.cjs` with the selected Node binary. It never
runs `npm install -g pnpm` and does not rely on an inherited Corepack home.

The default package-store scope is project-local for isolation. A global mode
may trade stronger cross-project isolation for more deduplication; it must keep
store integrity checking enabled and be documented as a weaker cache boundary.

### kubectl

The kubectl binary is an ordinary Tool Profile: local/managed on Process and a
verified Linux object on Apple Container. Selecting the binary grants no
cluster access. Official checksums are required. A server-version hint may
recommend a version, but resolution remains exact and follows Kubernetes
version-skew rules.

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
connections on revoke. Process uses a loopback endpoint; Apple Container uses a
private host-gateway bridge protected by TLS and the capability.

The sandbox kubeconfig contains only gateway endpoints, an ephemeral gateway CA,
and opaque capabilities. It is mounted read-only and removed on reload, revoke,
or shutdown. `KUBECONFIG` points only to this file, so unselected host contexts
are invisible.

A kubeconfig exec helper is not run while listing contexts. Before starting a
broker that needs `aws`, `gcloud`, `kubelogin`, or another helper, the extension
shows the exact helper invocation and obtains a session host-execution approval.
Helper output never enters the sandbox or model context.

## Apple mounts

```text
transactional workspace                         -> original guest cwd
read-only runtime/tool objects                  -> /opt/pi-toolchains, /opt/pi-tools
project-scoped mutable environments             -> /var/pi-env
managed caches                                  -> /var/pi-cache
session sanitized Kubernetes configuration      -> /opt/pi-kube/config.json
```

The guest policy allows exact corresponding paths. It does not expose host home,
raw kubeconfig, credentials, arbitrary sockets, or arbitrary mounts.

## Lifecycle and failure behavior

Startup loads trusted config, obtains the Selection, resolves versions, asks to
install missing objects, provisions the Environment Plan, selects Kubernetes
contexts, approves required host credential helpers, starts brokers, writes the
sanitized kubeconfig, initializes host ASRT, then preflights/selects Apple
Container.

A required runtime failure blocks shell startup. A failed Cluster Grant fails
closed for that context and exposes no kubeconfig entry; unrelated local shell
work may continue unless configuration explicitly marks the context required.
Forced Apple Container never downgrades. A declined installation returns to the
selector in TUI or blocks a required non-interactive Selection.

Shutdown stops containers and process groups, stops all Kubernetes brokers and
gateways, closes granted connections, deletes capabilities and sanitized config,
releases runtime leases, resets ASRT, and removes process-temporary data on quit.
Managed runtime objects and project environments remain for reuse.

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

`/sandbox` reports requested/effective backend, exact profiles/platform/source,
project environments, managed-store usage/quota, and active Kubernetes grants
without credential material.

## Module shape

```text
extensions/sandbox/
├── environments/
│   ├── types.ts
│   ├── selection.ts
│   ├── resolver.ts
│   ├── composer.ts
│   ├── installer.ts
│   ├── store.ts
│   ├── garbage-collector.ts
│   └── adapters/{go,python,node,pnpm,kubectl}.ts
├── kubernetes/
│   ├── kubeconfig-source.ts
│   ├── context-selector.ts
│   ├── credential-helper.ts
│   ├── broker.ts
│   ├── capability-gateway.ts
│   ├── access-policy.ts
│   └── sanitized-kubeconfig.ts
├── container/{Containerfile,guest-runner.mjs}
├── config.ts
├── process.ts
├── apple-container.ts
└── index.ts
```

The external seams remain small: resolve/provision/compose one Environment Plan,
and grant/revoke/stop the Kubernetes broker. Language and tool adapters remain
internal to those modules.

## Verification

Tests cover configuration precedence and trust, profile parsing and conflicts,
backend resolution, deterministic `PATH`, runtime probing, archive integrity and
safe extraction, concurrent installation, atomic publication, leases/quota/LRU,
read-only runtime enforcement, Apple mounts/bootstrap, Python venv persistence,
pnpm/Node compatibility, kubeconfig secret redaction, delayed exec-helper
approval, capability isolation, access/namespace policy, revoke behavior, and
Process/Apple integration.

End-to-end verification runs all selected tools in one sandbox:

```bash
go version
python --version
node --version
pnpm --version
kubectl version --client
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
4. Apple Container read-only runtime mounts and Debian/glibc bootstrap ABI.
5. Process Kubernetes metadata selection, TLS capability gateway, host
   `kubectl proxy`, sanitized kubeconfig, and revoke lifecycle.
6. Immutable objects, session leases, quota/retention LRU pruning, and
   sandbox-restricted archive extraction.
7. Apple private bridge-interface Kubernetes gateway and startup context
   selector without a public listener.
8. Pinned relocatable Python catalog (`3.11.11`/`3.12.9`/`3.13.2`) with
   cross-platform manifest coverage.
9. Apple project-scoped trusted-bootstrap Python venv and isolated pnpm store.
10. Environment and Kubernetes session controllers extracted from the extension
    entrypoint.
11. Failure-injection and recovery regression tests: installer HTTP/oversize
    and redirect, gateway non-loopback upstream, and store concurrent publish
    and corrupted/dangling reference recovery.

Remaining:

- Continue cross-platform (darwin-x64/linux-x64) catalog coverage and
  failure-injection integration hardening.

Recommended defaults are backend `auto`, install mode `ask`, globally shared
read-only Runtime Objects, project Python/pnpm state, no Kubernetes context grant,
`observe` access, context-default namespace, non-persistent context selection,
and host-broker credentials.
