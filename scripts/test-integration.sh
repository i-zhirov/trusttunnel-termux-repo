#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TOOLS_IMAGE="termux-repo-tools:local"
TERMUX_IMAGE="termux/termux-docker:x86_64@sha256:b0076e78b8569be23e7c57d5a98155abbebe16cd6be926fe5f4c47d2f0b8f211"

VERSIONS_BACKUP="$(mktemp)"
cp versions.json "$VERSIONS_BACKUP"

cleanup() {
  cp "$VERSIONS_BACKUP" versions.json
  rm -f "$VERSIONS_BACKUP"
  rm -rf site-unsigned site-signed
}
trap cleanup EXIT

docker build --target test .
docker build --target tools -t "$TOOLS_IMAGE" .

docker run --rm \
  -v "$ROOT:/work" \
  -e GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  "$TOOLS_IMAGE" \
  node scripts/build-repo.js --root /work --site /work/site-unsigned

docker run --rm \
  -v "$ROOT:/work" \
  -e GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  "$TOOLS_IMAGE" sh -c '
  set -e
  export GNUPGHOME=/tmp/gnupg
  mkdir -m 700 "$GNUPGHOME"
  gpg --batch --pinentry-mode loopback --passphrase "" \
    --quick-generate-key "Termux Repo Test <test@example.invalid>" rsa2048 sign 0
  node scripts/build-repo.js --root /work --site /work/site-signed --sign
'

docker run --rm -v "$ROOT:/work" "$TOOLS_IMAGE" sh -c '
  set -e
  for deb in /work/site-unsigned/dists/termux/extras/binary-*/*.deb; do
    dpkg-deb -I "$deb"
    dpkg-deb -c "$deb"
  done
'

docker run --rm -v "$ROOT:/work" "$TERMUX_IMAGE" bash -c '
  set -e
  mkdir -p "$PREFIX/etc/apt/sources.list.d"
  echo "deb [trusted=yes] file:///work/site-unsigned termux extras" \
    > "$PREFIX/etc/apt/sources.list.d/trusttunnel.list"
  apt update
  apt install -y trusttunnel-client trusttunnel
  trusttunnel_client --version
  trusttunnel_endpoint --version
'

docker run --rm -v "$ROOT:/work" "$TERMUX_IMAGE" bash -c '
  set -e
  mkdir -p "$PREFIX/etc/apt/sources.list.d"
  install -D -m 0644 /work/site-signed/keys/trusttunnel.gpg \
    "$PREFIX/etc/apt/trusted.gpg.d/trusttunnel.gpg"
  echo "deb [signed-by=$PREFIX/etc/apt/trusted.gpg.d/trusttunnel.gpg] file:///work/site-signed termux extras" \
    > "$PREFIX/etc/apt/sources.list.d/trusttunnel.list"
  apt update
  apt install -y trusttunnel-client
  trusttunnel_client --version
'

docker run --rm -v "$ROOT:/work" "$TOOLS_IMAGE" sh -c '
  set -e
  export GNUPGHOME=/tmp/gnupg-verify
  mkdir -m 700 "$GNUPGHOME"
  gpg --import /work/site-signed/keys/trusttunnel.gpg
  gpg --verify /work/site-signed/dists/termux/InRelease
'
