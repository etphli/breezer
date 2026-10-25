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
elif ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  echo "Finish Xcode's first-run setup and accept Apple's licence before building." >&2
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
elif ! "$BREEZER_PYTHON" -c 'from enum import StrEnum' 2>/dev/null; then
  echo "Chromium's build tools require Python 3.11 or newer. Recreate the build environment with Python 3.11." >&2
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
BREEZER_STAGE="${BREEZER_BUILD_DIR:-$BREEZER_ROOT/build/helium-macos}"
mkdir -p "$BREEZER_STAGE"
git archive HEAD:upstream/helium-macos | tar -x -C "$BREEZER_STAGE"

_root_dir="$BREEZER_STAGE"
source "$_root_dir/devutils/shared.sh"
BREEZER_PREPARED="$_root_dir/build/.breezer-prepared"
BREEZER_SOURCE_TREE="$(git rev-parse HEAD:upstream/helium-macos)"
BREEZER_BASE_PREPARATION_ID="$(
  {
    printf '%s\n' "$BREEZER_SOURCE_TREE"
    shasum -a 256 script/apply_breezer_branding.py assets/branding/breezer-logo.png upstream.lock.json
  } | shasum -a 256 | awk '{print $1}'
)"
BREEZER_AI_SOURCE_ID="$("$BREEZER_PYTHON" - "$BREEZER_ROOT" <<'PY'
import hashlib
from pathlib import Path
import sys
root = Path(sys.argv[1])
files = [root / 'script/apply_breezer_ai.py']
for directory in ('features/ai/extension', 'features/ai/integration'):
    files.extend(path for path in (root / directory).rglob('*') if path.is_file())
digest = hashlib.sha256()
for path in sorted(files):
    digest.update(path.relative_to(root).as_posix().encode() + b'\0')
    digest.update(hashlib.sha256(path.read_bytes()).digest())
print(digest.hexdigest())
PY
)"
BREEZER_PREPARATION_ID="$(printf '%s\n%s\n' "$BREEZER_BASE_PREPARATION_ID" "$BREEZER_AI_SOURCE_ID" | shasum -a 256 | awk '{print $1}')"
if [[ -f "$BREEZER_PREPARED" ]]; then
  BREEZER_PREVIOUS_PREPARATION="$(cat "$BREEZER_PREPARED")"
  if [[ "$BREEZER_PREVIOUS_PREPARATION" == "$BREEZER_BASE_PREPARATION_ID" ]]; then
    echo "Adding Breezer AI to the matching prepared browser; preserving compiled output."
    "$BREEZER_PYTHON" "$BREEZER_ROOT/script/check_ai_overlay.py" --grit-directory "$_src_dir/tools/grit"
    "$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_ai.py" "$_src_dir"
    printf '%s\n' "$BREEZER_PREPARATION_ID" > "$BREEZER_PREPARED.tmp"
    mv "$BREEZER_PREPARED.tmp" "$BREEZER_PREPARED"
  elif [[ "$BREEZER_PREVIOUS_PREPARATION" != "$BREEZER_PREPARATION_ID" ]]; then
    echo "Build inputs changed. The existing source and compiled output have been preserved in $BREEZER_STAGE." >&2
    echo "Set BREEZER_BUILD_DIR to a separate directory before preparing the changed source." >&2
    exit 1
  fi
  test -f "$_src_dir/chrome/app/theme/chromium/BRANDING"
  echo "Reusing prepared Breezer source and compiled output."
else
  prepare_sources true
  "$BREEZER_PYTHON" "$BREEZER_ROOT/script/check_branding.py" "$_src_dir/tools/grit"
  "$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_branding.py" "$_src_dir"
  "$BREEZER_PYTHON" "$BREEZER_ROOT/script/check_ai_overlay.py" --grit-directory "$_src_dir/tools/grit"
  "$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_ai.py" "$_src_dir"
  printf '%s\n' "$BREEZER_PREPARATION_ID" > "$BREEZER_PREPARED.tmp"
  mv "$BREEZER_PREPARED.tmp" "$BREEZER_PREPARED"
fi
write_gn_args "$_arch" release
if [[ "${BREEZER_DEVELOPMENT_BUILD:-0}" == 1 ]]; then
  cat >> "$_out_dir/args.gn" <<'GN'
is_official_build = false
chrome_pgo_phase = 0
symbol_level = 0
GN
fi
gn_gen
helium_build -j "${BREEZER_BUILD_JOBS:-2}"

BREEZER_APP="$_out_dir/Breezer.app"
test -x "$BREEZER_APP/Contents/MacOS/Breezer"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$BREEZER_APP/Contents/Info.plist")" = io.github.etphli.breezer
BREEZER_NODE_ARCH=arm64
if [[ "$_arch" == x86_64 ]]; then BREEZER_NODE_ARCH=x64; fi
"$BREEZER_PYTHON" "$BREEZER_ROOT/script/package_breezer_ai.py" "$BREEZER_APP" --arch "$BREEZER_NODE_ARCH"
while IFS= read -r -d '' BREEZER_NODE; do
  codesign --force --sign - "$BREEZER_NODE"
  codesign --verify --strict "$BREEZER_NODE"
done < <(find "$BREEZER_APP/Contents/Frameworks/Breezer Framework.framework/Versions" -path '*/Resources/breezer_ai/runtime/node' -type f -print0)
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
