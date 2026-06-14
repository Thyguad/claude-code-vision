#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('./package.json').version")"
APP_NAME="ClaudeCode-Vision.app"
BUILD_DIR="$ROOT_DIR/build"
DIST_DIR="$ROOT_DIR/dist"
DMG_NAME="ClaudeCode-Vision-$VERSION.dmg"
DMG_PATH="$DIST_DIR/$DMG_NAME"
STAGING_DIR="$BUILD_DIR/dmg"

"$ROOT_DIR/scripts/build-app.sh" >/dev/null

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$BUILD_DIR/$APP_NAME" "$STAGING_DIR/$APP_NAME"
ln -s /Applications "$STAGING_DIR/Applications"

mkdir -p "$DIST_DIR"
rm -f "$DMG_PATH"
hdiutil create \
  -volname "ClaudeCode-Vision $VERSION" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "$DMG_PATH"
