#!/usr/bin/env bash
set -euo pipefail

BREEZER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BREEZER_MODE="${1:-run}"
case "$BREEZER_MODE" in
  run|--check|--build-only|--install|--verify|--debug|--logs|--telemetry) ;;
  *) echo "Usage: $0 [--check|--build-only|--install|--verify|--debug|--logs|--telemetry]" >&2; exit 2 ;;
esac

if [[ "$(uname -s)" != Darwin ]]; then
  echo "A Mac with full Xcode 26 or newer is required to build Breezer." >&2
  exit 1
fi

BREEZER_MISSING=0
if ! BREEZER_XCODE="$(xcodebuild -version 2>/dev/null)"; then
  echo "Missing full Xcode 26. Install Xcode and select its Developer directory." >&2
  BREEZER_MISSING=1
elif [[ "$(awk '/^Xcode / {split($2, version, "."); print version[1]}' <<< "$BREEZER_XCODE")" -lt 26 ]]; then
  echo "Xcode 26 or newer is required." >&2
  BREEZER_MISSING=1
fi
for BREEZER_TOOL in greadlink wget zstd; do
  if ! command -v "$BREEZER_TOOL" >/dev/null; then
    echo "Missing build dependency: $BREEZER_TOOL" >&2
    BREEZER_MISSING=1
  fi
done
BREEZER_PYTHON="${BREEZER_PYTHON:-$BREEZER_ROOT/.venv/bin/python}"
if [[ ! -x "$BREEZER_PYTHON" ]]; then
  echo "Create the .venv environment described in docs/building-breezer.md." >&2
  BREEZER_MISSING=1
elif ! "$BREEZER_PYTHON" -c 'import requests; import PIL' 2>/dev/null; then
  echo "Install the upstream Python dependencies into .venv." >&2
  BREEZER_MISSING=1
fi
if [[ "$BREEZER_MISSING" -ne 0 ]]; then
  exit 1
fi
if [[ "$BREEZER_MODE" == --check ]]; then
  echo "Breezer build prerequisites are available."
  exit 0
fi

cd "$BREEZER_ROOT"
"$BREEZER_PYTHON" script/verify_upstream.py
export PATH="$(dirname "$BREEZER_PYTHON"):$PATH"
BREEZER_STAGE="$BREEZER_ROOT/build/helium-macos"
mkdir -p "$BREEZER_STAGE"
git archive HEAD:upstream/helium-macos | tar -x -C "$BREEZER_STAGE"

_root_dir="$BREEZER_STAGE"
source "$_root_dir/devutils/shared.sh"
prepare_sources true
"$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_branding.py" "$_src_dir"
configure_build "$_arch" release
helium_build

BREEZER_APP="$_out_dir/Breezer.app"
test -x "$BREEZER_APP/Contents/MacOS/Breezer"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$BREEZER_APP/Contents/Info.plist")" = io.github.etphli.breezer
codesign --force --deep --sign - "$BREEZER_APP"
codesign --verify --deep --strict "$BREEZER_APP"
echo "Source-built Breezer app: $BREEZER_APP"

if [[ "$BREEZER_MODE" == --build-only ]]; then
  exit 0
fi
pkill -x Breezer >/dev/null 2>&1 || true
if [[ "$BREEZER_MODE" == --install ]]; then
  BREEZER_DESTINATION="$HOME/Applications/Breezer.app"
  if [[ -e "$BREEZER_DESTINATION" ]]; then
    mkdir -p "$HOME/Applications/.Breezer-backups"
    mv "$BREEZER_DESTINATION" "$HOME/Applications/.Breezer-backups/Breezer-$(date +%Y%m%d-%H%M%S).app"
  fi
  ditto "$BREEZER_APP" "$BREEZER_DESTINATION"
  BREEZER_APP="$BREEZER_DESTINATION"
fi

case "$BREEZER_MODE" in
  --debug) lldb -- "$BREEZER_APP/Contents/MacOS/Breezer" ;;
  --logs|--telemetry)
    open -n "$BREEZER_APP"
    /usr/bin/log stream --info --style compact --predicate 'process == "Breezer"'
    ;;
  --verify)
    open -n "$BREEZER_APP"
    sleep 2
    pgrep -x Breezer >/dev/null
    ;;
  *) open -n "$BREEZER_APP" ;;
esac
