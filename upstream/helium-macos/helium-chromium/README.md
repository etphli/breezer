# Breezer browser source

The shared browser foundation for [Breezer](../../../README.md). Breezer is Ethan's personal browser project, with its own identity and a focus on browsing speed, resource use, and personal workflow.

## Source layout

- `patches/` contains changes applied to the pinned Chromium source.
- `resources/` contains browser artwork and resource mappings.
- `i18n/` contains inherited translations and translation metadata.
- `utils/` contains build tools and their tests.
- `devutils/` contains development tools and their tests.

The `helium-chromium` directory name is an internal build-tool path. It does not define the Breezer product name.

## Development

Use the [Breezer build guide](../../../docs/building-breezer.md) and the [repository's test commands](../../../README.md#source-and-tests). Chromium source is downloaded during a build.

The imported implementation is Breezer's starting point. Performance improvements and personal workflow changes remain development goals until implemented and measured.

## Upstream credit

Breezer builds on [Helium](https://github.com/imputnet/helium), [Chromium](https://www.chromium.org/), and [ungoogled-chromium](https://github.com/ungoogled-software/ungoogled-chromium). Their authors' copyright notices, tests, patches, and licences are retained.

Helium-authored additions are GPL-3.0. Other imported code retains its original licence. See [LICENSE](LICENSE) and [LICENSE.ungoogled_chromium](LICENSE.ungoogled_chromium). The [original upstream overview](../../../docs/upstream-originals/shared-browser.md) records the inherited layout and credits.
