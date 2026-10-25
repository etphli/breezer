<p align="center">
  <img src="assets/branding/breezer-logo.png" width="192" height="192" alt="Breezer logo">
</p>

# Breezer

A personal browser project based on [Helium](https://github.com/imputnet/helium).

The goals are faster browsing, lower memory and energy use, and an interface shaped around Ethan's workflow. These are development goals, not measured results.

## Project status

Helium 0.20.1.1's shared source and macOS build tools are imported with their original histories, licences, tests, and workflows. The macOS repository's `helium-chromium` submodule is embedded as its complete source tree, so cloning Breezer includes both repositories.

The intended deliverable is a browser built from this repository with Breezer's name and logo. There is no compiled Breezer release yet.

## Source and tests

[upstream.lock.json](upstream.lock.json) records the exact upstream commits and release checksum. The imported source is in [upstream/helium-macos](upstream/helium-macos), with shared code in [helium-chromium](upstream/helium-macos/helium-chromium).

Verify that every imported source file matches upstream:

```sh
python3 script/verify_upstream.py
```

Run every imported Python test and the configuration checks in an isolated environment:

```sh
python3.10 -m venv .venv
.venv/bin/python -m pip install -r upstream/helium-macos/helium-chromium/.requirements.txt
.venv/bin/python script/check_helium.py
```

GitHub Actions runs these checks on Linux. One upstream test assumes `/bin/false`, which exists on Linux but is `/usr/bin/false` on this Mac. The test is preserved without skips or edits.

Helium distributes patches and build tools rather than a complete Chromium checkout. Browser builds download the pinned Chromium source separately. Chromium's compiled browser tests require that build environment and have not been run here.

## Building on macOS

The [upstream build guide](upstream/helium-macos/docs/building.md) requires full Xcode 26 and its build dependencies. Command Line Tools alone are insufficient. Running the upstream `build.sh` currently produces Helium; Breezer branding must be integrated before publishing a Breezer app.

## Branding

The [Breezer logo](assets/branding/breezer-logo.png) is a full-resolution PNG with transparency around the app tile. The artwork was created with OpenAI's built-in image generation tool using the [saved prompt](assets/branding/logo-prompt.txt).

## Upstream

[Helium](https://helium.computer/) is the browser foundation. Helium-authored source is GPL-3.0, and imported third-party code retains its original licences. The original licence files and attribution notices are preserved throughout the imported source.
