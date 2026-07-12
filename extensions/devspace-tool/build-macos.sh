#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
BUILD_DIR="${BUILD_DIR:-$ROOT/.build}"
APP_DIR="$BUILD_DIR/DevSpace Tool.app"
EXECUTABLE="$APP_DIR/Contents/MacOS/DevSpaceTool"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

/usr/bin/swiftc \
  -parse-as-library \
  -O \
  -framework SwiftUI \
  -framework AppKit \
  "$ROOT/DevSpaceTool.swift" \
  -o "$EXECUTABLE"

/bin/cp "$ROOT/Info.plist" "$APP_DIR/Contents/Info.plist"
/usr/bin/codesign --force --deep --sign - "$APP_DIR"
/usr/bin/codesign --verify --deep --strict "$APP_DIR"

echo "$APP_DIR"
