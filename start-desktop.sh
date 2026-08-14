#!/usr/bin/env bash
# Launch deepseek-harness-desktop.
# Adds --no-sandbox only when the Electron SUID sandbox is not usable
# (e.g. chrome-sandbox is not root-owned with setuid, common in containers
# and some user installs). A normal desktop runs fully sandboxed.
set -euo pipefail

cd "$(dirname "$0")"

SANDBOX="node_modules/electron/dist/chrome-sandbox"
EXTRA=()
if [ ! -u "$SANDBOX" ] || [ "$(stat -c %U "$SANDBOX" 2>/dev/null)" != "root" ]; then
  EXTRA+=(--no-sandbox)
fi

exec node_modules/.bin/electron . "${EXTRA[@]}"
