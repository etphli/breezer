# Breezer for macOS

The macOS build foundation for [Breezer](../../README.md), Ethan's personal browser.

This directory contains platform build scripts, packaging resources, and macOS patches. Shared browser source is embedded in [helium-chromium](helium-chromium). That internal directory name keeps the inherited build tools compatible.

## Build and test

Start with the [Breezer build guide](../../docs/building-breezer.md). A full Xcode 26 installation is required. The installed Breezer app must come from Breezer's source build.

From the repository root, run the complete inherited test suite:

```sh
.venv/bin/python script/check_helium.py
```

## Foundation and licensing

This foundation comes from [Helium for macOS](https://github.com/imputnet/helium-macos), which builds on ungoogled-chromium-macos and Chromium. The existing tests, build tools, and licence notices are retained.

Helium-authored code is GPL-3.0. Imported third-party code retains its original licences. See [LICENSE](LICENSE) and [LICENSE.ungoogled_chromium](LICENSE.ungoogled_chromium). The [original upstream overview](../../docs/upstream-originals/macos.md) remains available for reference.
