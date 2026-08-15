#!/usr/bin/env bash
# Package the portable dir build (dist-portable/linux-unpacked) into a
# self-contained folder + zip, mirroring the Antigravity-x64 layout:
#   DeepSeek-Harness-x64/deepseek-harness   (executable, no space)
#   DeepSeek-Harness-x64/resources/         (app.asar + bundled runtime)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/dist-portable/linux-unpacked"
OUT="$ROOT/dist-portable/DeepSeek-Harness-x64"
ZIP="$ROOT/dist-portable/DeepSeek-Harness-x64.zip"

[ -d "$SRC" ] || { echo "未找到 $SRC（先跑 electron-builder --linux dir）"; exit 1; }

rm -rf "$OUT" "$ZIP"
mv "$SRC" "$OUT"

# Executable without a space, like Antigravity's `antigravity`.
if [ -e "$OUT/DeepSeek Harness" ]; then
  mv "$OUT/DeepSeek Harness" "$OUT/deepseek-harness-desktop"
fi
chmod +x "$OUT/deepseek-harness-desktop" 2>/dev/null || true

# Launch wrapper: zip extraction loses chrome-sandbox SUID (mode 4755), which
# makes the raw binary abort. The wrapper adds --no-sandbox only when the
# SUID sandbox is not usable — same logic as start-desktop.sh. It also runs
# the app in a new session (setsid) so closing the terminal that launched it
# does not kill the app (a SIGHUP from the terminal never reaches it).
cat > "$OUT/deepseek-harness" << 'WRAPPER'
#!/usr/bin/env bash
# DeepSeek Harness portable launcher (use this entry point, not
# deepseek-harness-desktop directly). Runs detached from the terminal.
set -euo pipefail
cd "$(dirname "$0")"
SANDBOX="./chrome-sandbox"
EXTRA=()
if [ ! -u "$SANDBOX" ] || [ "$(stat -c %U "$SANDBOX" 2>/dev/null)" != "root" ]; then
  EXTRA+=(--no-sandbox)
fi
exec setsid -f ./deepseek-harness-desktop "${EXTRA[@]}" "$@" > ./deepseek-harness.log 2>&1
WRAPPER
chmod +x "$OUT/deepseek-harness"

# Visible hint in the folder (empty marker file): "run deepseek-harness".
touch "$OUT/运行\"deepseek-harness\"文件"

echo "打包 zip ..."
(cd "$ROOT/dist-portable" && zip -r -y -q "DeepSeek-Harness-x64.zip" "DeepSeek-Harness-x64")

echo "完成:"
du -sh "$OUT" "$ZIP" 2>/dev/null
