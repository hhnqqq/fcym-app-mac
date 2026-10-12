#!/bin/bash
# 组装 Windows 发布包（在 macOS 上执行）
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DIST="$ROOT/windows-dist"
rm -rf "$DIST"
mkdir -p "$DIST/node" "$DIST/node_modules"

echo "[1/5] 复制核心文件"
cp harness.mjs extract.mjs AGENTS.md "$DIST/"
cp windows/*.cmd windows/fcym-tray.ps1 windows/README-WINDOWS.md "$DIST/"

echo "[2/5] 复制扩展原文件"
cp -R ext "$DIST/ext"
rm -f "$DIST/ext/js/.DS_Store"

echo "[3/5] 复制依赖（classic-level 自带 win32-x64 预编译）"
for dep in classic-level ws abstract-level module-error napi-macros node-gyp-build; do
  cp -R "node_modules/$dep" "$DIST/node_modules/" 2>/dev/null || true
done

echo "[4/5] 下载 Windows node.exe"
NODE_VER="${NODE_VER:-22.14.0}"
ZIP="/tmp/node-win-x64.zip"
if [ ! -f "$DIST/node/node.exe" ]; then
  # 优先 npmmirror（国内快），失败退 nodejs.org
  curl -L --fail --connect-timeout 20 -o "$ZIP" \
    "https://cdn.npmmirror.com/binaries/node/v${NODE_VER}/node-v${NODE_VER}-win-x64.zip" \
  || curl -L --fail --connect-timeout 20 -o "$ZIP" \
    "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-win-x64.zip"
  unzip -j -o "$ZIP" "node-v${NODE_VER}-win-x64/node.exe" -d "$DIST/node/"
  rm -f "$ZIP"
fi
ls -la "$DIST/node/"

echo "[5/5] 打 zip"
rm -f "$ROOT/fcym-client-windows.zip"
cd "$DIST" && zip -r -q "$ROOT/fcym-client-windows.zip" . && cd "$ROOT"
du -sh "$DIST" "$ROOT/fcym-client-windows.zip"
echo "完成: $DIST / $ROOT/fcym-client-windows.zip"
