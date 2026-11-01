# Page translation

Right-click an HTTP or HTTPS page and choose **Translate page**. You can also assign a **Translate page** shortcut at `chrome://extensions/shortcuts`. This opens a separate Breezer translation window, leaving the page available for reading and navigation. macOS selected-text translation keeps its existing native context-menu behavior.

Page translation requires a LibreTranslate server. Breezer does not bundle language models, supply a hosted API account, enable Google's disabled translation service, or use your Codex/Claude account.

## Set up a provider

Open Breezer Settings > Languages > Page translation.

- **Local LibreTranslate** is the default. Run a server on `http://localhost:5000`. After its language models are installed it can translate offline. A local service is a separate program you manage; Breezer does not install or start it.
- **LibreTranslate.com** is optional. Supply your own API key. Its service terms, account requirements and charges apply. Breezer never purchases access. Changing providers removes the previous provider's key unless you enter a replacement.

The provider address is fixed. Custom remote origins, proxies and arbitrary endpoints are not supported. This keeps extension permissions restricted to these two provider hosts. Browser host permissions cannot restrict ports; Breezer's code and connection policy restrict local requests to port 5000. Provider redirects are rejected.

For a local setup, follow the [LibreTranslate installation guide](https://docs.libretranslate.com/guides/installation/). For example, in a dedicated Python environment with a supported Python version:

```sh
python3.11 -m venv .translation-server
.translation-server/bin/pip install libretranslate
.translation-server/bin/libretranslate --host 127.0.0.1 --port 5000 --threads 1 --load-only en,es
```

The first run downloads models and needs network access. Choose the languages you need with `--load-only`; models use disk space and inference uses CPU/RAM. Model availability and Python/platform support belong to the provider. If downloads fail, follow its model-installation instructions or use your existing hosted account. Do not expose an unauthenticated local service to your network. A server configured to require a key can use the key field in Breezer too.

## Translate and restore

1. Open Translate page on the page you want to read.
2. Choose **Connect and load languages** and allow the provider connection. This fetches the provider's supported languages without sending page text.
3. Choose a source language, or Detect language, and a target language. Supported pairs come from the server's `/languages` response, not a hardcoded list. Installed models determine the available pairs. Auto-detection can fail on short or mixed-language text; choose the source explicitly in that case.
4. Confirm sending this page's visible text and choose **Translate page**. Progress appears in the window. Provider failures show a reason and a retry action. **Stop** cancels pending work; translations already applied stay visible.
5. Choose **Restore original** to restore text that Breezer changed. Translating again starts from the originals, allowing a different language pair.

The provider, source/target languages and preference for new text are saved locally. Sharing confirmation is never saved. There are no automatic site rules. Enable **Also translate new text** to watch changes only on the current page while the translation window is open. Closing the window stops further sharing and retains translated text. Reopening the action allows restoration. Navigation, including single-page URL changes while connected, stops sharing and requires opening the action again. Full navigation and page unload discard the old document state.

## Privacy and page behavior

Before translation, the window names the destination and asks for confirmation. The provider receives text in batches and the source/target languages. Visible text can contain private information. No page URL, browser cookies, referrer, form values, passwords or AI-account credentials are included in translation requests. A provider sees the request's IP address. The text itself might contain links or other identifying information. The local service may have its own logging and network behavior; hosted retention is controlled by that provider.

API keys stay in this device's extension storage, not sync storage, content scripts or the page. They are not encrypted vault entries. Clear them in settings when no longer needed. Source/translated text stays in the current document's isolated extension state for restoration and is never persisted by Breezer's translator.

Translation changes text-node data only. It does not replace elements, render provider HTML, inject remote scripts, change links, set form values or submit forms. Event handlers and DOM node identities remain intact. Provider output such as `<script>` is displayed as literal text. Pages that read their own displayed text for application logic can still react to changed text; restore the original if a site behaves unexpectedly.

Supported content is visible text in the main HTML document. Images, canvas, PDFs, browser/internal pages, private browsing, frame contents, shadow DOM, code/preformatted blocks, form controls, editable regions, hidden text and `translate="no"`/`.notranslate` regions are excluded. Attributes, placeholders, page titles, document language/direction and accessibility labels are not rewritten. Translating individual text nodes can lose sentence context across inline elements. Translations may change wrapping and page height; formatting and layout structure stay intact.

Long documents use sequential batches of at most 32 strings and 4,000 UTF-16 code units. Long nodes split at whitespace where possible, preserve boundary whitespace and keep their original node. A run processes at most 1,000,000 input code units, 50,000 text sections and 4,000,000 output code units. Nodes above 100,000 code units are skipped. The window reports skipped sections. Restore or retry for another run; the feature does not silently upload an unlimited stream from a changing page.

## Implementation and verification

`translation-background.js` owns provider calls, consent, navigation checks and extension messaging. `translation-provider.js` validates the LibreTranslate [text-batch API](https://docs.libretranslate.com/guides/api_usage/), applies request timeouts and bounds untrusted responses. `translation-content.js` runs in the [isolated extension world](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), uses the existing `activeTab` permission, and has no provider key or network client. The context-menu action or configured keyboard command supplies the [temporary page grant](https://developer.chrome.com/docs/extensions/get-started/tutorial/scripts-activetab). Only the main frame's injected document ID is connected.

`translation-settings.js` exports `async mountTranslationSettings({container, api})`, returning `{dispose}`. The Languages category mounts it in `#translation-settings`. The translation window links to `workspace.html#/settings/languages`.

```sh
npm ci --ignore-scripts --prefix tests/ai
npx --prefix tests/ai playwright install chromium
node --test tests/ai/translation.test.mjs tests/ai/translation-browser.test.mjs
# Separate opt-in acceptance against a real server on localhost:5000:
BREEZER_TRANSLATION_LIVE=1 node --test tests/ai/translation-browser.test.mjs
```

Browser checks create and delete disposable profiles and a temporary extension copy. They execute the shipped translation modules using real Chromium extension messaging and isolated-world injection. Only the test manifest substitutes fixture host grants for native context-menu invocation and optional permission prompts, and its worker excludes unrelated AI/usage services. The ordinary browser test uses a deterministic local HTTP provider fixture, proving DOM behavior and the provider contract, not translation quality. The opt-in live check requires an actual local model, checks Spanish-to-English page text and restoration, and writes separate evidence. Neither proves compiled Breezer integration, macOS native context-menu invocation, OS permission prompts or selected-text translation. Those require the integrated browser build.
