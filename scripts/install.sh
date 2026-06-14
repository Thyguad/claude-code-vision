#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
PROXY_DIR="$CLAUDE_DIR/vision-proxy"
APP_SUPPORT_DIR="$CLAUDE_DIR/vision-status-app"
APP_NAME="ClaudeCode-Vision.app"
APP_SOURCE_DIR="$ROOT_DIR/macos/app-template"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/claude-code-vision.XXXXXX")"
APP_BUILD_DIR="$BUILD_ROOT/$APP_NAME"
APP_INSTALL_DIR="${APP_INSTALL_DIR:-/Applications/$APP_NAME}"
trap 'rm -rf "$BUILD_ROOT"' EXIT

mkdir -p "$PROXY_DIR" "$APP_BUILD_DIR/Contents/MacOS" "$APP_BUILD_DIR/Contents/Resources"

cp "$ROOT_DIR/src/proxy.mjs" "$PROXY_DIR/proxy.mjs"
cp "$ROOT_DIR/scripts/visionctl.sh" "$PROXY_DIR/visionctl.sh"
cp "$ROOT_DIR/package.json" "$PROXY_DIR/package.json"
cp "$ROOT_DIR/package-lock.json" "$PROXY_DIR/package-lock.json"
chmod +x "$PROXY_DIR/visionctl.sh"

if [ ! -f "$PROXY_DIR/vision-model.json" ]; then
  cp "$ROOT_DIR/examples/vision-model.example.json" "$PROXY_DIR/vision-model.json"
fi

cd "$PROXY_DIR"
npm install --omit=dev

cp "$APP_SOURCE_DIR/Contents/Info.plist" "$APP_BUILD_DIR/Contents/Info.plist"
cp -R "$APP_SOURCE_DIR/Contents/Resources/." "$APP_BUILD_DIR/Contents/Resources/"
swiftc "$ROOT_DIR/macos/ClaudeCodeVision.swift" -o "$APP_BUILD_DIR/Contents/MacOS/ClaudeCode-Vision"

rm -rf "$APP_INSTALL_DIR"
cp -R "$APP_BUILD_DIR" "$APP_INSTALL_DIR"
xattr -cr "$APP_INSTALL_DIR" 2>/dev/null || true
codesign --force --deep --sign - "$APP_INSTALL_DIR" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_INSTALL_DIR" 2>/dev/null || true

echo "Installed: $APP_INSTALL_DIR"
echo "Proxy files: $PROXY_DIR"
