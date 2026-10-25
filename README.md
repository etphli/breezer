<p align="center">
  <img src="assets/branding/breezer-logo.png" width="192" height="192" alt="Breezer logo">
</p>

# Breezer

Breezer is Ethan's personal browser project. Its direction is a fast, efficient browser shaped around the way Ethan works.

This repository is Breezer's home for source, branding, build tools, and tests. The starting implementation comes from [Helium](https://github.com/imputnet/helium) and Chromium.

## Direction

Breezer aims to reduce startup time, memory use, and energy use while making everyday browsing fit Ethan's workflow. Performance improvements are goals until implemented and measured.

## Current status

The browser foundation and logo are in place. A proper Breezer app must be compiled from this repository with its own product identity. A renamed upstream download is not a Breezer release.

The first source build is waiting for full Xcode 26 on the build Mac. No compiled Breezer release is available yet.

## Source and tests

The macOS foundation is in [upstream/helium-macos](upstream/helium-macos). Shared patches, resources, translations, and tests are in its [helium-chromium](upstream/helium-macos/helium-chromium) directory. Those internal paths remain compatible with the inherited build tools.

[upstream.lock.json](upstream.lock.json) records the exact source commits and reference download checksum. Both upstream histories are retained. The READMEs describe Breezer; their original upstream versions are [archived separately](docs/upstream-originals).

Verify the source import:

```sh
python3 script/verify_upstream.py
```

Run every inherited Python test and the configuration checks:

```sh
python3.10 -m venv .venv
.venv/bin/python -m pip install -r upstream/helium-macos/helium-chromium/.requirements.txt
.venv/bin/python script/check_helium.py
```

GitHub Actions runs the complete suite on Linux. One inherited test assumes Linux's `/bin/false` path, which is `/usr/bin/false` on this Mac. The test is preserved without skips or edits.

Chromium itself is downloaded during a browser build. Its compiled browser tests require that build environment and have not been run here.

## Build Breezer

Follow the [Breezer macOS build guide](docs/building-breezer.md). Full Xcode 26 and the build dependencies are required.

## Branding

The [Breezer logo](assets/branding/breezer-logo.png) is a full-resolution PNG with transparency around the app tile. OpenAI's built-in image generation tool created it from the [saved prompt](assets/branding/logo-prompt.txt).

## Credits and licensing

Breezer builds on Helium, Chromium, ungoogled-chromium, and their contributors' work. Their copyright notices and licence terms remain in the source.

Helium-authored source is GPL-3.0. Imported third-party code retains its original licences. See [LICENSE](LICENSE) and [LICENSE.ungoogled_chromium](LICENSE.ungoogled_chromium).
