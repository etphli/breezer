# Build Breezer for macOS

This build compiles the pinned Chromium source with the imported browser patches and Breezer's product identity. The output must be a real `Breezer.app` with bundle identifier `io.github.etphli.breezer`.

The build command is prepared but has not completed a browser build yet. Full Xcode is missing on the initial build Mac.

## Prepare the build Mac

Install full Xcode 26 or newer and finish its first-run setup. Select that Xcode's Developer directory. Command Line Tools alone do not include the required Xcode build environment.

Install the inherited build dependencies:

```sh
brew install coreutils wget zstd readline
python3.10 -m venv .venv
.venv/bin/python -m pip install -r upstream/helium-macos/helium-chromium/.requirements.txt
```

Install the Metal toolchain if Xcode requests it. The [upstream build reference](../upstream/helium-macos/docs/building.md) lists the full toolchain requirements. Browser source downloads and compilation need substantial disk space and time.

Check the available tools before downloading Chromium:

```sh
./script/build_and_run.sh --check
```

## Compile the browser

Run from the Breezer repository root:

```sh
./script/build_and_run.sh --build-only
```

The command verifies the source snapshot and creates a build copy under `build/helium-macos`. It uses the inherited tools to download Chromium, apply patches, and prepare resources. Breezer branding is applied to that prepared source before compilation, including the product name, bundle identifier, profile directory, Keychain names, translated interface strings, and app icons.

The output is `build/helium-macos/build/src/out/Default/Breezer.app`. The upstream source and tests in the repository stay intact. Helium services and upstream attribution keep their real names.

The local build uses an ad hoc signature. It is not a notarized public release. Public distribution requires Breezer's own Apple signing identity and a verified packaging and notarization process.

## Install and launch

After prerequisites are available, build and install the source-built app:

```sh
./script/build_and_run.sh --install
```

The destination is `~/Applications/Breezer.app`. An existing app at that path is backed up before replacement. Breezer uses its own profile directory, `~/Library/Application Support/io.github.etphli.breezer`.

The default command builds and launches without installing. `--verify` also checks that the Breezer process starts. `--debug` opens the debugger, and `--logs` streams runtime logs.

## Tests

```sh
.venv/bin/python script/check_helium.py
```

The complete imported Python suite and configuration checks run in GitHub Actions on Linux. One inherited test uses Linux's `/bin/false` path and fails on this Mac, where the executable is `/usr/bin/false`. The test has not been skipped or changed.

Chromium's compiled browser tests require the complete browser build environment. They have not been run for Breezer yet.
