# Apple Container isolation layer

The sandbox extension can add Apple's native [`container`](https://github.com/apple/container) VM isolation around the existing process sandbox on macOS 26 and Apple silicon.

This mode is deliberately layered rather than selectable as a replacement:

```text
Pi direct-tool path gate
        |
Trusted host mount planner -> Apple Container lightweight VM -> Guest ASRT / bubblewrap
        |                                                              |
        +-- fixed CLI argv; command sent over stdin                     +-- actual user command
```

It is experimental and disabled by default.

## Security model

The same effective policy is enforced at multiple points:

- Pi's direct file tools keep using canonical host-path authorization.
- A trusted host planner builds fixed `container run` argv from canonical authorized paths. User command text is sent over stdin and can never become a host shell command or mount argument. Apple `container` cannot itself run under `sandbox-exec`: even an `(allow default)` profile makes its XPC service appear unregistered, so the launcher is deliberately outside Seatbelt.
- The VM sees only the transactional workspace, the session cache, and approved read-only directories.
- Guest ASRT applies the existing filesystem, domain, local-binding, and credential policy to the actual command using Linux bubblewrap and HTTP/SOCKS proxies. Apple Container's guest kernel rejects ASRT's second nested user namespace, so the Unix-socket seccomp helper is disabled with `allowAllUnixSockets`; no host Unix socket is mounted, and the VM supplies the stronger host-IPC boundary.
- Unlisted guest domains use the same Pi session approval set and TUI confirmation flow.

A layer that cannot represent a requested capability fails closed; it does not fall back to a direct writable mount or an unsandboxed guest command.

## Transactional APFS workspace

The host workspace is never mounted writable into the VM. Before each command the extension creates an APFS `clonefile` copy with `cp -cR`, then mounts that copy at the original absolute workspace path in the guest.

After the command exits, the trusted host reconciler:

1. hashes the original and staged trees;
2. rejects concurrent host changes;
3. computes creates, modifications, deletions, type changes, symlinks, and mode changes;
4. validates every change against `allowWrite`, configured `denyWrite`, and ASRT's mandatory protected paths;
5. commits the batch with a rollback journal;
6. removes the transaction directory.

If one path is denied, none of the command's changes are committed. This also protects deny patterns for files that did not exist before the command, which Linux bubblewrap alone cannot guarantee.

APFS is required. The extension refuses to copy the workspace on another filesystem, preventing an unexpectedly large full copy.

## Space behavior

- Apple container image content and unpacked snapshots are shared by Apple's content store.
- Per-container root filesystems use APFS copy-on-write clones and `--rm`.
- The project transaction uses APFS copy-on-write rather than a byte-for-byte copy.
- `/tmp` is tmpfs.
- One process-scoped cache directory is bind-mounted at `/var/pi-cache` and removed when Pi quits.
- The implementation never creates Apple named or anonymous volumes; anonymous volumes are not removed by `container run --rm`.
- The extension never runs global `container prune` or `container image prune`.

## Requirements

- Apple silicon
- macOS 26
- Apple container CLI 0.10.x
- The container system service already running
- Workspace and temporary transaction root on APFS
- A locally built `linux/arm64` guest image

Start the service in a normal host terminal:

```bash
container system start
```

Build the pinned guest image from this repository:

```bash
cd extensions/sandbox/container
container build --platform linux/arm64 \
  --tag local/pi-sandbox-asrt:0.0.70 \
  --file Containerfile .
```

The image contains Node.js, ASRT 0.0.70, bubblewrap, seccomp support, socat, ripgrep, bash, git, and CA certificates. `package-lock.json` pins transitive npm dependencies.

## Configuration

Enable the additional layer in a trusted `.pi/sandbox.json` or the global sandbox configuration:

```json
{
  "isolation": {
    "appleContainer": {
      "enabled": true,
      "binary": "/opt/homebrew/bin/container",
      "image": "local/pi-sandbox-asrt:0.0.70",
      "platform": "linux/arm64",
      "shell": "/bin/bash",
      "cpus": 2,
      "memory": "2g",
      "pullPolicy": "never",
      "workspaceMode": "transactional-apfs"
    }
  }
}
```

`pullPolicy` and `workspaceMode` are intentionally fixed. The extension checks that the image already exists before enabling bash, so it does not silently download an image. Pinning a custom local image to an immutable digest is recommended once the workflow is stable.

Run `/sandbox reload`, then `/sandbox`. The status includes all active isolation layers and policy-parity mode.

## Current fail-closed restrictions

The first implementation supports transactional writes only for the current workspace:

- An approved external **directory read** is mounted read-only and receives the guest Process policy.
- An approved external **file read** remains usable by direct Pi tools, but shell execution fails until directory-safe staging is implemented.
- Any external **write grant** makes container shell execution fail. It never becomes a direct writable host mount.
- Host-executed credential commands (`git push`, `gh`, configured cloud CLIs) retain their existing explicit approval path and do not enter the VM.
- SSH-agent, Docker-socket, arbitrary socket, arbitrary mount, and raw `container` arguments are not exposed.

These restrictions preserve policy strength while the remaining transactional staging cases are implemented.

## Failure and cleanup

Initialization fails closed if the CLI, service, image, platform, version, or configuration is unavailable. During execution, cancellation and timeout send a guest cancellation message, force-delete the named container, terminate the launcher process group, and discard the transaction.

Every managed container has the label `com.pi.sandbox.managed=true` and an unpredictable `pi-sbx-*` name. Session shutdown force-deletes containers tracked by the current extension instance. The implementation does not delete unrelated containers or images.

## Integration verification

The repository unit tests cover policy compilation, launch arguments, protected-path matching, APFS transaction commit, and all-or-nothing rejection. Full VM verification must be run outside an already-confined Pi shell because the current sandbox intentionally blocks unapproved Apple container XPC access:

```bash
npm test
PI_APPLE_CONTAINER_INTEGRATION=1 \
  node --experimental-strip-types --test \
  extensions/sandbox/apple-container.integration.test.mjs
```

The integration test expects the pinned local image and running service. It starts a short-lived parent proxy on the host gateway so it works on host networks where Apple VMs cannot directly reach external addresses, while still validating guest ASRT's HTTPS domain allow/deny decisions.

Before treating the mode as stable, verify on the target machine:

- guest bubblewrap initializes without weaker nested filesystem mode; the VM exposes no host Unix sockets because ASRT's nested Unix-socket seccomp helper is incompatible with the Apple guest kernel;
- allowed and denied domains behave identically to process-only mode;
- cancellation and timeout leave no `pi-sbx-*` container;
- protected new files such as `.env` never reach the host;
- repeated no-op commands do not grow container disk usage continuously.
