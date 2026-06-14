#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="ClaudeCode-Vision.app"
APP_SOURCE_DIR="$ROOT_DIR/macos/app-template"
BUILD_DIR="$ROOT_DIR/build"
APP_BUILD_DIR="$BUILD_DIR/$APP_NAME"
RUNTIME_DIR="$APP_BUILD_DIR/Contents/Resources/vision-proxy"

rm -rf "$APP_BUILD_DIR"
mkdir -p "$APP_BUILD_DIR/Contents/MacOS" "$APP_BUILD_DIR/Contents/Resources" "$RUNTIME_DIR"

cp "$APP_SOURCE_DIR/Contents/Info.plist" "$APP_BUILD_DIR/Contents/Info.plist"
cp -R "$APP_SOURCE_DIR/Contents/Resources/." "$APP_BUILD_DIR/Contents/Resources/"

cp "$ROOT_DIR/src/proxy.mjs" "$RUNTIME_DIR/proxy.mjs"
cp "$ROOT_DIR/scripts/visionctl.sh" "$RUNTIME_DIR/visionctl.sh"
cp "$ROOT_DIR/package.json" "$RUNTIME_DIR/package.json"
cp "$ROOT_DIR/package-lock.json" "$RUNTIME_DIR/package-lock.json"
cp "$ROOT_DIR/examples/vision-model.example.json" "$RUNTIME_DIR/vision-model.example.json"
chmod +x "$RUNTIME_DIR/visionctl.sh"

swiftc "$ROOT_DIR/macos/ClaudeCodeVision.swift" -o "$APP_BUILD_DIR/Contents/MacOS/ClaudeCode-Vision"

xattr -cr "$APP_BUILD_DIR" 2>/dev/null || true
codesign --force --deep --sign - "$APP_BUILD_DIR" 2>/dev/null || true

echo "$APP_BUILD_DIR"
