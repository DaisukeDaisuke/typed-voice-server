#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
CODEX_VERSION="0.147.0"
CLOUDFLARED_VERSION="2026.8.2"
DENO_VERSION="2.9.5"

printf '\n[typed-voice-server] Ensuring ripgrep is available...\n'
if ! command -v rg >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends ripgrep
fi
rg --version | head -n 1

printf '\n[typed-voice-server] Installing Codex CLI...\n'
npm install -g "@openai/codex@${CODEX_VERSION}"

printf '\n[typed-voice-server] Installing Deno...\n'
if ! command -v unzip >/dev/null 2>&1 && ! command -v 7z >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends unzip
fi
curl -fsSL https://deno.land/install.sh \
  | sudo DENO_INSTALL=/usr/local sh -s "v${DENO_VERSION}" --yes --no-modify-path
deno --version | head -n 1

printf '\n[typed-voice-server] Verifying Codex Linux sandbox...\n'
node scripts/codex-sandbox-check.mjs --non-interactive

printf '\n[typed-voice-server] Installing cloudflared...\n'
case "$(uname -m)" in
  x86_64) cloudflared_arch="amd64" ;;
  aarch64|arm64) cloudflared_arch="arm64" ;;
  *) printf 'Unsupported cloudflared architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
tmp_cloudflared="$(mktemp)"
trap 'rm -f "$tmp_cloudflared"' EXIT
curl -L --fail --retry 3 \
  "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${cloudflared_arch}" \
  -o "$tmp_cloudflared"
sudo install -m 0755 "$tmp_cloudflared" /usr/local/bin/cloudflared
rm -f "$tmp_cloudflared"
trap - EXIT

printf '\n[typed-voice-server] Initializing typed-voice sources...\n'
git submodule update --init --recursive typed-voice

printf '\n[typed-voice-server] Running Node core tests...\n'
node --test test/*.test.mjs

printf '\n[typed-voice-server] Ready.\n'
printf '  codex:       %s\n' "$(codex --version)"
printf '  deno:        %s\n' "$(deno --version | head -n 1)"
printf '  cloudflared: %s\n' "$(cloudflared --version)"
printf '  server:      node server-main.mjs\n'
