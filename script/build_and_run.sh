#!/usr/bin/env bash
set -euo pipefail

# Exit status 3: an existing prepared tree no longer matches this checkout's
# inputs. It is preserved unchanged and must not be cached as current progress.
BREEZER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BREEZER_MODE="${1:-run}"
case "$BREEZER_MODE" in
  run|--check|--build-only|--install|--verify|--debug|--logs|--telemetry) ;;
  *) echo "Usage: $0 [--check|--build-only|--install|--verify|--debug|--logs|--telemetry]" >&2; exit 2 ;;
esac

check_install_hold() {
  if [[ "$BREEZER_MODE" != --install || "${BREEZER_OVERRIDE_UPDATE_HOLD:-0}" == 1 ]]; then
    return 0
  fi
  local common_dir hold reason
  # Linked worktrees share the installed app and the primary checkout's hold.
  common_dir="$(git -C "$BREEZER_ROOT" rev-parse --path-format=absolute --git-common-dir)"
  for hold in "$BREEZER_ROOT/build/local-update-hold.json" "${common_dir%/*}/build/local-update-hold.json"; do
    if [[ -e "$hold" || -L "$hold" ]]; then
      reason="$(plutil -extract instruction raw -expect string -o - "$hold" 2>/dev/null ||
                plutil -extract reason raw -expect string -o - "$hold" 2>/dev/null ||
                printf '%s\n' 'No readable reason was recorded.')"
      printf 'Local Breezer installation is on hold (%s).\n%s\n' "$hold" "$reason" >&2
      echo "For an explicitly authorized install, set BREEZER_OVERRIDE_UPDATE_HOLD=1." >&2
      exit 1
    fi
  done
}
check_install_hold

if [[ -z "${BREEZER_BUILD_PROFILE:-}" ]]; then
  BREEZER_BUILD_PROFILE=upstream
  if [[ "${BREEZER_DEVELOPMENT_BUILD:-0}" == 1 ]]; then
    BREEZER_BUILD_PROFILE=development
  fi
elif [[ "${BREEZER_DEVELOPMENT_BUILD:-0}" == 1 && "$BREEZER_BUILD_PROFILE" != development ]]; then
  echo "Use BREEZER_BUILD_PROFILE alone, or select development with BREEZER_DEVELOPMENT_BUILD=1." >&2
  exit 2
fi

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
BREEZER_PROFILE_ARGS="$("$BREEZER_PYTHON" "$BREEZER_ROOT/script/breezer_build_profile.py" --profile "$BREEZER_BUILD_PROFILE")"
if [[ "$BREEZER_MODE" == --check ]]; then
  echo "Breezer build prerequisites are available."
  exit 0
fi

cd "$BREEZER_ROOT"
"$BREEZER_PYTHON" script/verify_upstream.py
export PATH="$(dirname "$BREEZER_PYTHON"):$PATH"
BREEZER_STAGE="${BREEZER_BUILD_DIR:-$BREEZER_ROOT/build/helium-macos}"
# BEGIN frame-budget preflight
if [[ "${BREEZER_FRAME_BUDGET_EXPERIMENT:-0}" == 1 ]]; then
  if [[ "$BREEZER_MODE" != --build-only || "${BREEZER_FRAME_BUDGET_PRIVATE_COPY:-0}" != 1 ]]; then
    echo "Frame-budget preparation requires --build-only and BREEZER_FRAME_BUDGET_PRIVATE_COPY=1 for a private quiescent copy." >&2
    exit 2
  fi
  "$BREEZER_PYTHON" -B - "$BREEZER_STAGE" "$BREEZER_ROOT/build/helium-macos" <<'PYFRAME'
from pathlib import Path
import sys
stage, default = (Path(value).resolve() for value in sys.argv[1:])
if stage.is_relative_to(default) or default.is_relative_to(stage):
    sys.exit("Frame-budget preparation requires a separate private BREEZER_BUILD_DIR.")
if not (stage / 'build/.breezer-prepared').is_file():
    sys.exit("Frame-budget preparation requires an existing verified prepared copy; no fresh preparation or cache recreation.")
if (stage / 'build/src/out').is_symlink():
    sys.exit("Frame-budget preparation requires a private output directory, not an aliased output root.")
PYFRAME
  "$BREEZER_PYTHON" -B "$BREEZER_ROOT/script/apply_breezer_frame_budget.py" --preflight "$BREEZER_STAGE/build/src"
elif [[ -e "$BREEZER_STAGE/build/src/.breezer-frame-budget-prepared" || -L "$BREEZER_STAGE/build/src/.breezer-frame-budget-prepared" ||
        -e "$BREEZER_STAGE/build/src/.breezer-frame-budget-preparing" || -L "$BREEZER_STAGE/build/src/.breezer-frame-budget-preparing" ]]; then
  echo "Experimental frame-budget source requires BREEZER_FRAME_BUDGET_EXPERIMENT=1; preserve this copy and use a separate default build tree." >&2
  exit 1
else
  "$BREEZER_PYTHON" -B "$BREEZER_ROOT/script/apply_breezer_frame_budget.py" --guard-default "$BREEZER_STAGE/build/src"
fi
# END frame-budget preflight
if [[ -n "${BREEZER_COMPILED_FILTERS:-}" ]]; then
  if [[ "$BREEZER_MODE" != --build-only ]]; then
    echo "The compiled-list experiment requires --build-only; it cannot install or open an app." >&2
    exit 2
  fi
  "$BREEZER_PYTHON" - "$BREEZER_STAGE" "$BREEZER_ROOT/build/helium-macos" <<'PY'
from pathlib import Path
import sys
stage, default = (Path(value).resolve() for value in sys.argv[1:])
if stage.is_relative_to(default) or default.is_relative_to(stage):
    sys.exit("The compiled-list experiment requires a separate BREEZER_BUILD_DIR outside the default build tree.")
PY
fi
if [[ -f "$BREEZER_STAGE/build/src/.breezer-filter-lists-prepared" && -z "${BREEZER_COMPILED_FILTERS:-}" ]]; then
  echo "This source tree contains the opt-in compiled-list experiment. Supply its BREEZER_COMPILED_FILTERS directory or use a separate build directory." >&2
  exit 1
fi
mkdir -p "$BREEZER_STAGE"
_root_dir="$BREEZER_STAGE"
# Read this commit's path definitions without changing the stage; upstream build
# scripts are extracted only after the prepared inputs below are verified.
BREEZER_UPSTREAM_ENV="$(git -C "$BREEZER_ROOT" show HEAD:upstream/helium-macos/env.sh)"
eval "$BREEZER_UPSTREAM_ENV"
_out_dir="$("$BREEZER_PYTHON" "$BREEZER_ROOT/script/breezer_build_profile.py" \
  --profile "$BREEZER_BUILD_PROFILE" --source-dir "$_src_dir" --out-dir "${BREEZER_OUT_DIR:-}")"
BREEZER_PREPARED="$_root_dir/build/.breezer-prepared"
if [[ ! -f "$BREEZER_PREPARED" && -d "$_src_dir/out" ]] &&
   [[ -n "$(find "$_src_dir/out" -mindepth 1 -print -quit)" ]]; then
  echo "Prepared-source marker is missing. Existing output is preserved in $_src_dir/out." >&2
  echo "Use a separate BREEZER_BUILD_DIR or verify the preparation marker before rebuilding." >&2
  exit 3
fi
echo "Breezer build profile: $BREEZER_BUILD_PROFILE; output: $_out_dir"
BREEZER_OMNIBOX_PREPARED="$_src_dir/.breezer-omnibox-prepared"
BREEZER_OMNIBOX_ID="$("$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_omnibox.py" --fingerprint)"
if [[ -e "$BREEZER_OMNIBOX_PREPARED" ]] &&
   [[ "$(cat "$BREEZER_OMNIBOX_PREPARED")" != "$BREEZER_OMNIBOX_ID" ]]; then
  echo "Omnibox overlay inputs changed. Existing source and compiled output are preserved in $BREEZER_STAGE." >&2
  echo "Set BREEZER_BUILD_DIR to a separate directory; changed overlays require fresh base preparation." >&2
  exit 3
fi
BREEZER_WORKSPACE_ID="$("$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_workspace.py" --fingerprint)"
BREEZER_AI_UI_ID="$("$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_ai_ui.py" --fingerprint)"
BREEZER_PASSWORDS_ID="$("$BREEZER_PYTHON" "$BREEZER_ROOT/features/passwords/native-ui/apply.py" --fingerprint)"
BREEZER_CLONE_ID="$("$BREEZER_PYTHON" "$BREEZER_ROOT/features/storage/code-sign-clones/apply.py" --fingerprint)"
BREEZER_CLONE_PREPARED="$_src_dir/.breezer-code-sign-clones-prepared"
if [[ -f "$BREEZER_CLONE_PREPARED" ]] && [[ "$(cat "$BREEZER_CLONE_PREPARED")" != "$BREEZER_CLONE_ID" ]]; then
  echo "Signature-clone overlay changed. Existing source and compiled caches are preserved; verify a targeted overlay migration before rebuilding." >&2
  exit 3
fi
BREEZER_SYNC_ID="$("$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_sync.py" --fingerprint)"
for BREEZER_OVERLAY in workspace ai-ui passwords sync; do
  if [[ "$BREEZER_OVERLAY" == workspace ]]; then
    BREEZER_OVERLAY_ID="$BREEZER_WORKSPACE_ID"
  elif [[ "$BREEZER_OVERLAY" == ai-ui ]]; then
    BREEZER_OVERLAY_ID="$BREEZER_AI_UI_ID"
  elif [[ "$BREEZER_OVERLAY" == sync ]]; then
    BREEZER_OVERLAY_ID="$BREEZER_SYNC_ID"
  else
    BREEZER_OVERLAY_ID="$BREEZER_PASSWORDS_ID"
  fi
  BREEZER_OVERLAY_MARKER="$_src_dir/.breezer-$BREEZER_OVERLAY-prepared"
  if [[ -e "$BREEZER_OVERLAY_MARKER" ]] &&
     [[ "$(cat "$BREEZER_OVERLAY_MARKER")" != "$BREEZER_OVERLAY_ID" ]]; then
    echo "$BREEZER_OVERLAY native overlay changed. Source and compiled output are preserved in $BREEZER_STAGE." >&2
    echo "Use a separate build directory or a separately verified overlay migration." >&2
    exit 3
  fi
done
BREEZER_SOURCE_TREE="$(git rev-parse HEAD:upstream/helium-macos)"
BREEZER_BASE_PREPARATION_ID="$(
  {
    printf '%s\n' "$BREEZER_SOURCE_TREE"
    shasum -a 256 script/apply_breezer_branding.py script/breezer_release.py features/ai/extension/release-info.js assets/branding/breezer-logo.png upstream.lock.json
  } | shasum -a 256 | awk '{print $1}'
)"
BREEZER_PREPARATION_ID="$("$BREEZER_PYTHON" "$BREEZER_ROOT/script/breezer_preparation.py" --base-id "$BREEZER_BASE_PREPARATION_ID")"
BREEZER_REFRESH_AI=false
if [[ -f "$BREEZER_PREPARED" ]]; then
  BREEZER_PREVIOUS_PREPARATION="$(cat "$BREEZER_PREPARED")"
  if [[ "$BREEZER_PREVIOUS_PREPARATION" == "$BREEZER_PREPARATION_ID" ]]; then
    :
  elif [[ "$BREEZER_PREVIOUS_PREPARATION" == "$BREEZER_BASE_PREPARATION_ID" ]]; then
    BREEZER_REFRESH_AI=true
  elif [[ -d "$_src_dir/components/breezer_ai" ]] &&
       BREEZER_RECONSTRUCTED_PREPARATION="$("$BREEZER_PYTHON" "$BREEZER_ROOT/script/breezer_preparation.py" \
         --base-id "$BREEZER_BASE_PREPARATION_ID" --prepared-extension "$_src_dir/components/breezer_ai")" &&
       [[ "$BREEZER_PREVIOUS_PREPARATION" == "$BREEZER_RECONSTRUCTED_PREPARATION" ]]; then
    BREEZER_REFRESH_AI=true
  else
    echo "Build inputs changed. The existing source and compiled output have been preserved in $BREEZER_STAGE." >&2
    echo "Set BREEZER_BUILD_DIR to a separate directory before preparing the changed source." >&2
    exit 3
  fi
fi
# The stage is unprepared or verified, so its upstream build scripts can be refreshed.
git archive HEAD:upstream/helium-macos | tar -x -C "$BREEZER_STAGE"
BREEZER_PROFILE_OUT_DIR="$_out_dir"
source "$_root_dir/devutils/shared.sh"
_out_dir="$BREEZER_PROFILE_OUT_DIR"
if [[ -f "$BREEZER_PREPARED" ]]; then
  if [[ "$BREEZER_REFRESH_AI" == true ]]; then
    echo "Updating Breezer AI resources with verified matching native inputs; preserving compiled output."
    "$BREEZER_PYTHON" "$BREEZER_ROOT/script/check_ai_overlay.py" --grit-directory "$_src_dir/tools/grit"
    "$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_ai.py" "$_src_dir"
    printf '%s\n' "$BREEZER_PREPARATION_ID" > "$BREEZER_PREPARED.tmp"
    mv "$BREEZER_PREPARED.tmp" "$BREEZER_PREPARED"
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
if [[ ! -f "$BREEZER_OMNIBOX_PREPARED" ]]; then
  "$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_omnibox.py" "$_src_dir"
fi
"$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_omnibox.py" --check "$_src_dir"
printf '%s\n' "$BREEZER_OMNIBOX_ID" > "$BREEZER_OMNIBOX_PREPARED.tmp"
mv "$BREEZER_OMNIBOX_PREPARED.tmp" "$BREEZER_OMNIBOX_PREPARED"
for BREEZER_OVERLAY in workspace ai-ui passwords sync; do
  if [[ "$BREEZER_OVERLAY" == workspace ]]; then
    BREEZER_OVERLAY_SCRIPT=script/apply_breezer_workspace.py
    BREEZER_OVERLAY_ID="$BREEZER_WORKSPACE_ID"
  elif [[ "$BREEZER_OVERLAY" == ai-ui ]]; then
    BREEZER_OVERLAY_SCRIPT=script/apply_breezer_ai_ui.py
    BREEZER_OVERLAY_ID="$BREEZER_AI_UI_ID"
  elif [[ "$BREEZER_OVERLAY" == sync ]]; then
    BREEZER_OVERLAY_SCRIPT=script/apply_breezer_sync.py
    BREEZER_OVERLAY_ID="$BREEZER_SYNC_ID"
  else
    BREEZER_OVERLAY_SCRIPT=features/passwords/native-ui/apply.py
    BREEZER_OVERLAY_ID="$BREEZER_PASSWORDS_ID"
  fi
  BREEZER_OVERLAY_MARKER="$_src_dir/.breezer-$BREEZER_OVERLAY-prepared"
  if [[ ! -f "$BREEZER_OVERLAY_MARKER" ]]; then
    "$BREEZER_PYTHON" "$BREEZER_ROOT/$BREEZER_OVERLAY_SCRIPT" "$_src_dir"
  fi
  "$BREEZER_PYTHON" "$BREEZER_ROOT/$BREEZER_OVERLAY_SCRIPT" --check "$_src_dir"
  printf '%s\n' "$BREEZER_OVERLAY_ID" > "$BREEZER_OVERLAY_MARKER.tmp"
  mv "$BREEZER_OVERLAY_MARKER.tmp" "$BREEZER_OVERLAY_MARKER"
done
if [[ ! -f "$BREEZER_CLONE_PREPARED" ]]; then
  "$BREEZER_PYTHON" "$BREEZER_ROOT/features/storage/code-sign-clones/apply.py" "$_src_dir"
fi
"$BREEZER_PYTHON" "$BREEZER_ROOT/features/storage/code-sign-clones/apply.py" --check "$_src_dir"
printf '%s\n' "$BREEZER_CLONE_ID" > "$BREEZER_CLONE_PREPARED.tmp"
mv "$BREEZER_CLONE_PREPARED.tmp" "$BREEZER_CLONE_PREPARED"
if [[ -n "${BREEZER_COMPILED_FILTERS:-}" ]]; then
  "$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_filter_lists.py" "$_src_dir" --artifacts "$BREEZER_COMPILED_FILTERS"
  "$BREEZER_PYTHON" "$BREEZER_ROOT/script/apply_breezer_filter_lists.py" "$_src_dir" --artifacts "$BREEZER_COMPILED_FILTERS" --check
fi
# BEGIN frame-budget preparation
if [[ "${BREEZER_FRAME_BUDGET_EXPERIMENT:-0}" == 1 ]]; then
  "$BREEZER_PYTHON" -B "$BREEZER_ROOT/script/apply_breezer_frame_budget.py" --private-quiescent-copy "$_src_dir"
  "$BREEZER_PYTHON" -B "$BREEZER_ROOT/script/apply_breezer_frame_budget.py" --check "$_src_dir"
fi
# END frame-budget preparation
write_gn_args "$_arch" release
if [[ -n "$BREEZER_PROFILE_ARGS" ]]; then
  printf '%s\n' "$BREEZER_PROFILE_ARGS" >> "$_out_dir/args.gn"
fi
gn_gen
helium_build -j "${BREEZER_BUILD_JOBS:-2}"

BREEZER_APP="$_out_dir/Breezer.app"
test -x "$BREEZER_APP/Contents/MacOS/Breezer"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$BREEZER_APP/Contents/Info.plist")" = io.github.etphli.breezer
BREEZER_NODE_ARCH=arm64
if [[ "$_arch" == x86_64 ]]; then BREEZER_NODE_ARCH=x64; fi
BREEZER_PACKAGE_ARGS=("$BREEZER_APP" --arch "$BREEZER_NODE_ARCH")
if [[ -n "${BREEZER_MEMORY_PACKET:-}" ]]; then
  BREEZER_PACKAGE_ARGS+=(--memory-packet "$BREEZER_MEMORY_PACKET")
fi
"$BREEZER_PYTHON" "$BREEZER_ROOT/script/package_breezer_ai.py" "${BREEZER_PACKAGE_ARGS[@]}"
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
check_install_hold

# Development launches use a separate profile so an unreleased build never opens
# or migrates the real one. --install keeps using the real profile.
BREEZER_DEV_PROFILE_DIR=""
if [[ "$BREEZER_MODE" != --install && "${BREEZER_USE_REAL_PROFILE:-0}" != 1 ]]; then
  BREEZER_DEV_PROFILE_DIR="${BREEZER_DEV_PROFILE:-$BREEZER_ROOT/build/dev-profile}"
  mkdir -p "$BREEZER_DEV_PROFILE_DIR"
  echo "Using development profile: $BREEZER_DEV_PROFILE_DIR (set BREEZER_USE_REAL_PROFILE=1 for the real profile)"
fi

launch_breezer() {
  if [[ -n "$BREEZER_DEV_PROFILE_DIR" ]]; then
    open -n "$BREEZER_APP" --args --user-data-dir="$BREEZER_DEV_PROFILE_DIR"
  else
    open -n "$BREEZER_APP"
  fi
}

running_breezer_executables() {
  ps -ww -axo uid=,comm= | awk -v uid="$UID" '
    $1 == uid {
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "")
      if ($0 ~ /\/Contents\/MacOS\/Breezer$/) print
    }'
}

has_breezer_executable() {
  [[ $'\n'$1$'\n' == *$'\n'"$2"$'\n'* ]]
}

quit_breezer() {
  local executable="$1" running deadline
  running="$(running_breezer_executables)"
  if ! has_breezer_executable "$running" "$executable"; then
    return 0
  fi
  # Quit only the running app at this path. Looking up by name can select the installed copy.
  osascript -l JavaScript - "$executable" <<'JXA'
ObjC.import('AppKit');
function run(argv) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('io.github.etphli.breezer');
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    if (ObjC.unwrap(app.executableURL.path) === argv[0]) {
      app.terminate;
    }
  }
}
JXA
  deadline=$((SECONDS + 15))
  while has_breezer_executable "$running" "$executable"; do
    if (( SECONDS >= deadline )); then
      printf 'Breezer did not quit within 15 seconds: %s\n' "$executable" >&2
      exit 1
    fi
    sleep 1
    running="$(running_breezer_executables)"
  done
}

BREEZER_APP="$(greadlink -f -- "$BREEZER_APP")"
BREEZER_DESTINATION="$(greadlink -m -- "$HOME/Applications")/Breezer.app"
BREEZER_EXECUTABLE="$BREEZER_APP/Contents/MacOS/Breezer"
BREEZER_INSTALLED_EXECUTABLE="$(greadlink -m -- "$BREEZER_DESTINATION/Contents/MacOS/Breezer")"
if [[ "$BREEZER_EXECUTABLE" == "$BREEZER_INSTALLED_EXECUTABLE" ]]; then
  echo "Select a build output separate from the installed Breezer app." >&2
  exit 1
fi

BREEZER_RUNNING="$(running_breezer_executables)"
while IFS= read -r BREEZER_RUNNING_EXECUTABLE; do
  # Other Breezer copies can keep running when this build uses its own profile.
  if [[ -n "$BREEZER_DEV_PROFILE_DIR" ]]; then
    break
  fi
  if [[ -z "$BREEZER_RUNNING_EXECUTABLE" || "$BREEZER_RUNNING_EXECUTABLE" == "$BREEZER_EXECUTABLE" ]]; then
    continue
  fi
  if [[ "$BREEZER_MODE" == --install && "$BREEZER_RUNNING_EXECUTABLE" == "$BREEZER_INSTALLED_EXECUTABLE" ]]; then
    continue
  fi
  printf 'Quit the running Breezer before launching a build on the same profile: %s\n' "$BREEZER_RUNNING_EXECUTABLE" >&2
  exit 1
done <<< "$BREEZER_RUNNING"

quit_breezer "$BREEZER_EXECUTABLE"
if [[ "$BREEZER_MODE" == --install ]]; then
  quit_breezer "$BREEZER_INSTALLED_EXECUTABLE"
fi
BREEZER_RUNNING="$(running_breezer_executables)"
if [[ -n "$BREEZER_DEV_PROFILE_DIR" ]]; then
  if has_breezer_executable "$BREEZER_RUNNING" "$BREEZER_EXECUTABLE"; then
    printf 'This Breezer build is still running. Close it before continuing: %s\n' "$BREEZER_EXECUTABLE" >&2
    exit 1
  fi
elif [[ -n "$BREEZER_RUNNING" ]]; then
  printf 'Breezer is still running. Close it before continuing.\n%s\n' "$BREEZER_RUNNING" >&2
  exit 1
fi
verify_installed_app() {
  local app="$1"
  [[ -x "$app/Contents/MacOS/Breezer" ]] &&
    [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null)" == io.github.etphli.breezer ]] &&
    codesign --verify --deep --strict "$app"
}

if [[ "$BREEZER_MODE" == --install ]]; then
  BREEZER_BACKUP=""
  if [[ -e "$BREEZER_DESTINATION" || -L "$BREEZER_DESTINATION" ]]; then
    BREEZER_BACKUPS="$(greadlink -m -- "$HOME/Applications")/.Breezer-backups"
    mkdir -p "$BREEZER_BACKUPS"
    # A unique, not-yet-existing name: mv into an existing path would nest the app.
    BREEZER_BACKUP="$BREEZER_BACKUPS/Breezer-$(date +%Y%m%d-%H%M%S)-$(uuidgen | tr 'A-Z' 'a-z' | cut -c1-8).app"
    if [[ -e "$BREEZER_BACKUP" || -L "$BREEZER_BACKUP" ]]; then
      printf 'Backup path already exists: %s\n' "$BREEZER_BACKUP" >&2
      exit 1
    fi
    mv "$BREEZER_DESTINATION" "$BREEZER_BACKUP"
  fi
  if ! ditto "$BREEZER_APP" "$BREEZER_DESTINATION" || ! verify_installed_app "$BREEZER_DESTINATION"; then
    echo "The installed copy failed verification; restoring the previous app." >&2
    rm -rf "$BREEZER_DESTINATION"
    if [[ -n "$BREEZER_BACKUP" ]]; then
      mv "$BREEZER_BACKUP" "$BREEZER_DESTINATION"
    fi
    exit 1
  fi
  if [[ -n "$BREEZER_BACKUP" ]]; then
    printf 'Previous app retained: %s\n' "$BREEZER_BACKUP"
  fi
  BREEZER_APP="$BREEZER_DESTINATION"
fi

case "$BREEZER_MODE" in
  --debug) lldb -- "$BREEZER_APP/Contents/MacOS/Breezer" ${BREEZER_DEV_PROFILE_DIR:+"--user-data-dir=$BREEZER_DEV_PROFILE_DIR"} ;;
  --logs|--telemetry)
    launch_breezer
    /usr/bin/log stream --info --style compact --predicate 'process == "Breezer"'
    ;;
  --verify)
    launch_breezer
    sleep 2
    BREEZER_RUNNING="$(running_breezer_executables)"
    if ! has_breezer_executable "$BREEZER_RUNNING" "$BREEZER_EXECUTABLE"; then
      printf 'Could not verify a running Breezer process at %s\n' "$BREEZER_EXECUTABLE" >&2
      exit 1
    fi
    ;;
  *) launch_breezer ;;
esac
