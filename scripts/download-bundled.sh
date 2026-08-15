#!/usr/bin/env bash
# Download the portable runtime bundle: node + pnpm + dsh (fixed versions).
# Output: ./bundled/  (node/, pnpm/, dsh/) — packaged via extraResources.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/bundled"

NODE_VERSION="${NODE_VERSION:-v22.23.1}"
PNPM_VERSION="${PNPM_VERSION:-9.15.0}"
DSH_VERSION="${DSH_VERSION:-0.1.0-rc.6}"

rm -rf "$DEST"
mkdir -p "$DEST/node" "$DEST/dsh" "$DEST/pnpm"

echo "[1/3] node $NODE_VERSION ..."
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" \
  | tar -xJ -C "$DEST/node" --strip-components=1

echo "[2/3] pnpm $PNPM_VERSION ..."
curl -fsSL "https://github.com/pnpm/pnpm/releases/download/v$PNPM_VERSION/pnpm-linux-x64" \
  -o "$DEST/pnpm/pnpm"
chmod +x "$DEST/pnpm/pnpm"

echo "[3/3] dsh $DSH_VERSION ..."
cd "$DEST/dsh"
"$DEST/node/bin/node" "$DEST/node/bin/npm" init -y >/dev/null 2>&1
"$DEST/node/bin/node" "$DEST/node/bin/npm" install --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION" >/dev/null 2>&1

echo "完成: $DEST"
du -sh "$DEST" "$DEST/node" "$DEST/dsh" "$DEST/pnpm" 2>/dev/null | head -4
