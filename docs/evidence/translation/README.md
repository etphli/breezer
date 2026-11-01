# Translation acceptance evidence

Captured 1 November 2026 in a disposable Chrome for Testing 156.0.8078.4 profile, using the shipped translation modules loaded as an isolated test extension. These images show an actual local model response, not the deterministic fixture.

- [Translation controls](controls.png)
- [Translated page](page-live.png)
- [Exact output and restoration](live.json)

Provider: local LibreTranslate 1.9.6 in `/tmp/breezer-translation-provider-venv`, with one server thread and one Argos inference thread. The model and all package/config/cache paths used disposable `/tmp/breezer-translation-provider-*` locations. No user browser data or installed app was used. The server was stopped after acceptance.

The current model index was reachable, but `argos-net.com` did not resolve. The test installed the provider's [official backup Spanish-to-English model](https://github.com/LibreTranslate/LibreTranslate-Models/blob/main/es_en.argosmodel). SHA-256 of the downloaded archive: `1b963aa0e0cb6e5ce874f0aa1a1949a19bc4d762e833532239a8834340f6b378`.

The paragraph `La biblioteca abre por la mañana.` became `The library opens in the morning.` and restored exactly. The older backup model translated `Hola mundo` as `Hello`, omitting a word. This is evidence of execution, not a claim of translation quality. The button and input were deliberately unchanged. Translation quality varies by provider/model and context.

The browser acceptance fixture substitutes host grants for native context-menu invocation and browser permission prompts. It does not prove compiled Breezer integration, native macOS interaction or selected-text translation. No compiled browser containing this branch was available. The coordinator's ongoing PC build predates these changes.

Other verification:

- Translation provider/background unit tests pass. The real unpacked-extension fixture passes consent, language choice, literal untrusted output, unchanged elements/form behavior, batching, restoration, dynamic text, cancel/retry, navigation, saved preferences and provider credential separation.
- `python3 script/check_ai_overlay.py` passes against pinned Chromium and both Helium patch series, including extension resources and idempotence. This is source-overlay evidence, not a Chromium compile or GRIT PAK build.
- The full local Node suite initially passed 261 of 262 checks. The unrelated, unmodified `visual-polish-browser.test.mjs` new-tab site geometry check expects eight visible sites but sees nine. A focused rerun reproduces it. Neither that test nor its new-tab inputs are changed by this feature.

Reproduce the live path with the opt-in command in [the translation guide](../../translation.md). It requires an actual local server. The ordinary fixture test intentionally does not download models or make paid-provider calls.
