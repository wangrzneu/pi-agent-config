#!/usr/bin/env bash
set -euo pipefail

proxy="${PI_SANDBOX_BUILD_PROXY:?Set PI_SANDBOX_BUILD_PROXY to an HTTP CONNECT proxy reachable from the Apple Container network}"
container_binary="${PI_CONTAINER_BINARY:-/opt/homebrew/bin/container}"
image="${PI_SANDBOX_IMAGE:-local/pi-sandbox-asrt:0.0.70}"

case "$proxy" in
  http://*|https://*) ;;
  *)
    printf 'PI_SANDBOX_BUILD_PROXY must be an http:// or https:// URL\n' >&2
    exit 2
    ;;
esac

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_directory"

exec "$container_binary" build \
  --platform linux/arm64 \
  --tag "$image" \
  --build-arg "HTTP_PROXY=$proxy" \
  --build-arg "HTTPS_PROXY=$proxy" \
  --build-arg "http_proxy=$proxy" \
  --build-arg "https_proxy=$proxy" \
  --file Containerfile \
  .
