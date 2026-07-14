#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
BUILD_DIR="${BUILD_DIR:-$ROOT/.build}"
APP_DIR="$BUILD_DIR/DevSpace Tool.app"
EXECUTABLE="$APP_DIR/Contents/MacOS/DevSpaceTool"
ICON_SOURCE="$ROOT/../../docs/assets/devspace-logo-light.png"
GENERATED_ICON_SOURCE="$BUILD_DIR/DevSpaceToolIcon.png"
ICONSET_DIR="$BUILD_DIR/DevSpaceTool.iconset"
ICON_FILE="$APP_DIR/Contents/Resources/DevSpaceTool.icns"

rm -rf "$APP_DIR" "$ICONSET_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

/usr/bin/swiftc \
  -parse-as-library \
  -O \
  -framework SwiftUI \
  -framework AppKit \
  "$ROOT/ModelPricing.swift" \
  "$ROOT/UsageCore.swift" \
  "$ROOT/DevSpaceToolView.swift" \
  "$ROOT/DevSpaceTool.swift" \
  -o "$EXECUTABLE"

/bin/cp "$ROOT/Info.plist" "$APP_DIR/Contents/Info.plist"

if [[ ! -f "$ICON_SOURCE" && -f "$ROOT/GenerateIcon.swift" ]]; then
  /usr/bin/swift "$ROOT/GenerateIcon.swift" "$GENERATED_ICON_SOURCE"
  ICON_SOURCE="$GENERATED_ICON_SOURCE"
fi

if [[ -f "$ICON_SOURCE" ]]; then
  mkdir -p "$ICONSET_DIR"
  /usr/bin/sips -z 16 16 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
  /usr/bin/sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
  /usr/bin/sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
  /usr/bin/sips -z 64 64 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
  /usr/bin/sips -z 128 128 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
  /usr/bin/sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
  /usr/bin/sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
  /usr/bin/sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
  /usr/bin/sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
  /usr/bin/sips -z 1024 1024 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null
  /usr/bin/iconutil -c icns "$ICONSET_DIR" -o "$ICON_FILE"
  rm -rf "$ICONSET_DIR"
fi

/usr/bin/codesign --force --deep --sign - "$APP_DIR"
/usr/bin/codesign --verify --deep --strict "$APP_DIR"

echo "$APP_DIR"
