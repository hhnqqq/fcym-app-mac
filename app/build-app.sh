#!/bin/bash
# 组装 FcymClient.app
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/app/FcymClient.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/harness"

# 1. Swift 菜单栏壳
cp "$ROOT/app/FcymClient" "$APP/Contents/MacOS/FcymClient"

# 2. harness（运行时数据独立存放于 ~/Library/Application Support/FcymClient）
for f in harness.mjs extract.mjs package.json README.md; do cp "$ROOT/$f" "$APP/Contents/Resources/harness/" 2>/dev/null || true; done
cp -R "$ROOT/ext" "$APP/Contents/Resources/harness/ext"
rm -rf "$APP/Contents/Resources/harness/ext/js/.DS_Store"
mkdir -p "$APP/Contents/Resources/harness/node_modules"
for dep in classic-level ws; do cp -R "$ROOT/node_modules/$dep" "$APP/Contents/Resources/harness/node_modules/" 2>/dev/null || true; done
# ws 依赖极小且独立；classic-level 依赖 @electron/... 预编译
for dep in $(cd "$ROOT" && node -e "console.log(Object.keys(require('./node_modules/classic-level/package.json').dependencies||{}).join(' '))" 2>/dev/null); do
  cp -R "$ROOT/node_modules/$dep" "$APP/Contents/Resources/harness/node_modules/" 2>/dev/null || true
done

# 3. 内置 Node 运行时（自包含，不依赖 nvm）
NODE_BIN="$(command -v node)"
cp "$NODE_BIN" "$APP/Contents/Resources/node"
chmod +x "$APP/Contents/Resources/node"

# 4. 图标
cp "$ROOT/app/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# 5. Info.plist
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>风车云马</string>
    <key>CFBundleDisplayName</key>
    <string>风车云马系统客户端</string>
    <key>CFBundleIdentifier</key>
    <string>com.hehaonan.fcymclient</string>
    <key>CFBundleExecutable</key>
    <string>FcymClient</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
</dict>
</plist>
EOF

# 6. PkgInfo
printf 'APPLfcym' > "$APP/Contents/PkgInfo"

# 7. Ad-hoc 签名
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "打包完成: $APP"
du -sh "$APP"
