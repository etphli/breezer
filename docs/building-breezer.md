# Build Breezer for macOS

This build compiles the pinned Chromium source with the imported browser patches and Breezer's product identity. The output must be a real `Breezer.app` with bundle identifier `io.github.etphli.breezer`.

Breezer supports local incremental builds. Keep the prepared source and compiled output to reuse completed work when rebuilding changes.

## Build without local Xcode

Use the [Build Breezer for Apple Silicon workflow](https://github.com/etphli/breezer/actions/workflows/build-breezer-macos.yml) to compile on a GitHub-hosted Mac. Xcode is required on the build machine; it is not needed to run the resulting app on your Mac.

Run the workflow from GitHub Actions. It verifies the source, prepares the browser, applies Breezer branding, and attempts compilation. A successful build also runs a headless browser smoke test and uploads `Breezer-arm64.zip`. Download the `Breezer-arm64` artifact from the successful run within one day.

The workflow saves compilation progress before GitHub's job time limit. If the run reports a saved checkpoint, rerun the workflow to resume. A full Chromium build can need several runs. The hosted environment has passed its Xcode and resource checks; a successful hosted Breezer artifact has not yet been verified.

Hosted builds use a development configuration with profile-guided optimization, debug symbols, and precompiled headers disabled. The pinned compiler treats the precompiled-header command's module name as a C++ module interface and fails on Chromium's header. Compiling those headers normally avoids that toolchain failure. These builds compile the same browser source and retain the tests. They are not notarized public releases.

## Prepare another build Mac

Existing build machines can reuse their configured toolchain. To prepare another build machine, install full Xcode 26 or newer and finish its first-run setup. Select that Xcode's Developer directory. Command Line Tools alone do not include the required Xcode build environment.

Install the inherited build dependencies:

```sh
brew install coreutils wget zstd readline
python3.11 -m venv .venv
.venv/bin/python -m pip install -r upstream/helium-macos/helium-chromium/.requirements.txt
```

Install the Metal toolchain if Xcode requests it. The [upstream build reference](../upstream/helium-macos/docs/building.md) lists the full toolchain requirements. Browser source downloads and compilation need substantial disk space and time.

Use Python 3.11 for the native build. The pinned Chromium build tools use `enum.StrEnum`, which is unavailable in the imported project's older Python 3.10 test environment.

Check the available tools before downloading Chromium:

```sh
./script/build_and_run.sh --check
```

## Compile the browser

Run from the Breezer repository root:

```sh
./script/build_and_run.sh --build-only
```

The command verifies the source snapshot and creates a build copy under `build/helium-macos`. It uses the inherited tools to download Chromium, apply patches, and prepare resources. Breezer branding is applied to that prepared source before compilation, including the product name, bundle identifier, profile directory, Keychain names, translated interface strings, and app icons. The AI overlay then adds the built-in side panel, native Command K binding, resources, and private native-host lookup. Its resource PAK is checked with the pinned Chromium GRIT tools.

Retries reuse a fully prepared source tree and its compiled output when the inputs match. Extension resource updates can also retain compiled objects: the wrapper reconstructs the previous preparation hash from saved extension bytes and verifies that the browser source, branding, native AI overlay, and integration identity still match. It then refreshes the resource files and lets the build system rebuild their dependents. Removed extension files or changed native preparation inputs require a separate `BREEZER_BUILD_DIR`. A matching prepared browser from before the AI overlay can receive that overlay while retaining compiled objects. Set `BREEZER_BUILD_JOBS` to change the default limit of two compiler jobs.

The address-bar suggestion overlay runs after AI preparation and before GN. Its separate fingerprint is stored at `build/helium-macos/build/src/.breezer-omnibox-prepared`, inside the cached source tree. A verified base and AI checkpoint can receive this first overlay while retaining compiled output. Every reuse checks the applied source. A different existing omnibox fingerprint requires a fresh `BREEZER_BUILD_DIR`, because applying a new patch cannot remove retired changes. See the [overlay contract](omnibox-suggestions.md).

The hosted cache groups checkpoints by native preparation and omnibox inputs so extension updates can resume earlier compilation. To migrate a checkpoint saved by the previous cache format, provide its exact key in the workflow's optional `checkpoint_cache_key` input. The wrapper still verifies that checkpoint before reusing it. The cache path list stays unchanged so pre-omnibox compilation checkpoints remain compatible; the omnibox marker travels inside the cached source directory.

The output is `build/helium-macos/build/src/out/Default/Breezer.app`. The upstream source and tests in the repository stay intact. Helium services and upstream attribution keep their real names.

Before signing, the build packages the AI host and a checksum-pinned Node runtime, including its licence, inside the framework resources. The resulting app does not need a system Node installation. Using AI requires an installed, signed-in Codex or Claude CLI. Provider credentials remain with those CLIs. See the [sidebar guide](ai-sidebar.md) for configuration and verification.

The local build uses an ad hoc signature. It is not a notarized public release. Public distribution requires Breezer's own Apple signing identity and a verified packaging and notarization process.

## Build profiles and separate outputs

`BREEZER_BUILD_PROFILE` selects GN overrides after the inherited release configuration:

- `upstream` is the default. It retains the inherited official build and PGO phase 2 settings and uses `out/Default`.
- `development` retains the existing `BREEZER_DEVELOPMENT_BUILD=1` behavior. It sets `is_official_build=false`, `chrome_pgo_phase=0`, `symbol_level=0`, and `enable_precompiled_headers=false`, and uses `out/Default`. The legacy environment variable remains supported. Do not combine it with a different explicit profile.
- `release-performance` uses the same four development overrides and adds `is_debug=false`, `dcheck_always_on=false`, and `enable_expensive_dchecks=false`. Its default output is `out/ReleasePerformance`. It is a release-performance experiment without PGO or ThinLTO, not an official distribution build.

Chromium's pinned `build/config/dcheck_always_on.gni` defaults DCHECKs on for non-official Chromium builds, even with `is_debug=false`. Expensive DCHECKs follow that setting. `v8/BUILD.gn` derives debug code, write-barrier verification, heap-accounting checks, and test-only hooks from it; `v8/gni/v8.gni` also enables cppgc API checks. The previously compiled development output therefore had `-DDCHECK_ALWAYS_ON=1`, `V8_ENABLE_DEBUG_CODE`, and `CPPGC_ENABLE_API_CHECKS`, despite already using `-O2`.

The performance profile lets these developer checks follow Chromium's release defaults. This also removes debug-only PartitionAlloc cookies and extra protection for pointers annotated as unprotected in release, as defined in `base/allocator/partition_allocator/partition_alloc.gni`. CHECK failures remain fatal. The profile does not override sandboxing, site isolation, V8 pointer compression, BackupRefPtr support, libc++ hardening, stack initialization, sanitizers, or CFI settings. Do not substitute compiler flags that disable those protections. The pinned macOS configuration defaults `is_cfi=false`; this profile preserves that default rather than disabling CFI.

Inspect the proposed overrides without preparing source or running GN:

```sh
python3 script/breezer_build_profile.py --profile release-performance
```

When ready to compile, use the existing prepared source and a separate output:

```sh
env -u BREEZER_DEVELOPMENT_BUILD BREEZER_BUILD_PROFILE=release-performance \
  ./script/build_and_run.sh --build-only
```

`BREEZER_BUILD_DIR` continues to select the complete staging tree, including downloaded and prepared source. `BREEZER_OUT_DIR` selects a GN output inside that source tree's `out` directory. It can be source-relative, such as `out/PerfCandidate`, or an absolute path inside the same `out` directory. The wrapper applies it after upstream `env.sh` sets `_out_dir`. The performance profile refuses `out/Default` and its descendants, including symlink aliases. The example produces `build/helium-macos/build/src/out/ReleasePerformance/Breezer.app`. Install and launch remain separate command modes.

Existing source fingerprints must still match. A profile change does not authorize rewriting overlay markers or preparing changed native inputs in place. If the prepared-source marker is missing and any output exists, the wrapper refuses preparation because the inherited preparation step deletes `src/out`. Verify the marker or use a separate staging tree. No profile selection deletes old objects, downloads, or output directories.

Disabling DCHECK changes the global compiler defines and generated headers. Expect a substantial native rebuild and new V8 snapshots, not a relink. Isolated GN generation on the inspected M1 took 8.5 seconds and wrote about 426 MiB of build metadata. Its `chrome` and `chromedriver` dependency graph contains 46,861 clang compile commands. The previous graph had 46,863 commands carrying `DCHECK_ALWAYS_ON`; the new graph has none. This is close to a full native recompile. These counts describe planned commands, not completed compilation.

A fresh output has no local objects to reuse; a configured compiler cache may supply matching objects, but developer-check objects are not interchangeable with release objects. Keep `out/Default` for rollback and incremental development. On the inspected M1 with 8 GiB RAM it occupied about 9.1 GiB. Budget another browser output of similar order, plus temporary link space. There is no measured full-build duration for the new profile; plan for hours and possibly an overnight build at two jobs, then revise that estimate from actual progress. GN generation alone does not measure compile time or runtime performance.

On APFS, the build owner can first clone the completed `out/Default` to a new, absent `out/ReleasePerformance` with macOS `cp -cR`. This initially shares storage while keeping writes independent. Regenerate GN in the cloned output before building. Matching objects may be reusable; changed defines still force the affected objects to rebuild and consume additional storage. Do not use hard links. The wrapper accepts such an independently cloned output and does not delete its objects.

The inherited official profile is a separate, more expensive experiment. `build/config/compiler/compiler.gni` enables ThinLTO for official Apple builds using LLD; `build/config/compiler/BUILD.gn` enables its optimization passes. PGO phase 2 adds profile-use flags to native compilation and requires the exact pinned profile named by `chrome/build/mac-arm.pgo.txt` or `mac.pgo.txt`. The inspected source already contains those profiles. Official mode also changes CHECK logging and other release settings. These changes invalidate native objects again and increase link work and memory demand. They may improve code layout, startup, or execution, but the size and direction of the benefit require measurement. Keep the precompiled-header workaround when evaluating that configuration. Start with the smaller DCHECK-only experiment before committing this Mac to official, PGO, and ThinLTO builds.

Before accepting a performance build, inspect its generated compile commands for the absence of `DCHECK_ALWAYS_ON`, `V8_ENABLE_DEBUG_CODE`, and `CPPGC_ENABLE_API_CHECKS`, and verify that existing hardening flags remain. `gn args --list` shows declared defaults; V8's empty-string defaults are resolved later, so use the generated commands or the built output's `v8_build_config.json` to verify their effective values. Repeat the same paired browser benchmark and report every metric and timeout. This profile alone establishes no speedup or advantage over Chrome.

Run the focused profile and output-preservation checks without Chromium compilation:

```sh
python3 script/check_breezer_build_profile.py
bash -n script/build_and_run.sh
```

## Install and launch

To install a completed hosted build, install [GitHub CLI](https://cli.github.com/) and sign in with `gh auth login`. Supply the successful workflow run ID and its full commit SHA:

```sh
python3 script/install_breezer.py --run-id RUN_ID --commit FULL_40_CHARACTER_COMMIT_SHA
```

The installer requires an Apple Silicon Mac. It checks that the run succeeded in `etphli/breezer`, used `build-breezer-macos.yml`, and compiled exactly the supplied commit. A run that is still compiling, failed, or only saved a checkpoint cannot be installed. The run must contain one unexpired `Breezer-arm64` artifact. Use this repository's matching runtime pin when installing an older build.

Before replacement, the installer verifies the browser ZIP's SHA-256, rejects unsafe ZIP paths and symlinks, and extracts with macOS `ditto`. It checks Breezer's bundle identity, native Apple Silicon browser and framework executables, private AI host and manifest, bundled Node runtime lock and licence, and strict deep code signature. These development builds use ad hoc signing and are not notarized releases. The installer does not alter quarantine attributes or bypass macOS launch checks.

The default destination is `~/Applications/Breezer.app`. Quit an existing Breezer before replacing it. The installer retains the previous app under `~/Applications/.Breezer-backups/` with a unique name and restores it if replacement validation or receipt creation fails. To restore a backup later, quit Breezer and move the retained app back to `~/Applications/Breezer.app`. Profiles stay in `~/Library/Application Support/io.github.etphli.breezer` and are not modified by installation.

An installation receipt records the run, commit, artifact, archive checksum, and backup path in `~/Library/Application Support/io.github.etphli.breezer-installer/receipts/`, outside the signed app. The default command launches Breezer and checks for its browser process. Use `--no-launch` to install without opening it, or `--destination /path/to/Breezer.app` for another location. If macOS blocks launch or no process is observed, the validated app and receipt remain installed and the command reports launch verification failure.

Build and install the source-built app locally with:

```sh
./script/build_and_run.sh --install
```

The local build command uses `~/Applications/Breezer.app` and backs up an existing app before replacement. Its default mode builds and launches without installing. `--verify` also checks that the Breezer process starts. `--debug` opens the debugger, and `--logs` streams runtime logs.

## Package a Breezer app as a DMG

The packager accepts an existing `Breezer.app`. It checks the bundle and signature, copies the app with `ditto`, adds an Applications shortcut, creates a compressed read-only DMG, verifies the image, and writes a SHA-256 sidecar. The output directory must already exist, and the command refuses to replace either output file.

```sh
mkdir -p dist
python3 script/package_breezer_dmg.py "$HOME/Applications/Breezer.app" dist/Breezer.dmg
cd dist
shasum -a 256 -c Breezer.dmg.sha256
```

These apps use an ad hoc signature. The DMG is not notarized for public release.

Run the installer's synthetic unit checks without downloading or installing a browser:

```sh
python3 script/check_breezer_installer.py
```

Those checks cover run and artifact refusals, checksum and ZIP safety, bundle validation calls, replacement rollback, and concurrent installation. They do not establish that a compiled Breezer app launches or that a real app signature passes.

## Tests

```sh
.venv/bin/python script/check_helium.py
```

The complete imported Python suite and configuration checks run in GitHub Actions on Linux. One inherited test uses Linux's `/bin/false` path and fails on this Mac, where the executable is `/usr/bin/false`. The test has not been skipped or changed.

Chromium's compiled browser tests require the complete browser build environment. They have not been run for Breezer yet.
