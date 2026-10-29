# Update pages

The bundled update page is `features/ai/extension/whats-new.html`. Its cream design contains the current minor release's features and appended patch notes. Open it in Breezer at:

```text
chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/whats-new.html
```

## Code map

| File under `features/ai/extension/` | Responsibility |
| --- | --- |
| `whats-new.html` | Feature copy, patch sections and local illustrations. |
| `whats-new.css` | Cream palette, layout, artwork, focus, forced colors and reduced motion. |
| `whats-new.js` | Reads `RELEASE_VERSION`, sets the masthead/title with `textContent`, closes this tab on Continue browsing and handles close refusal. |
| `release-info.js` | Published version and derived minor-page version. For example, `1.1.2` maps to `1.1.0`. |
| `release-notes.js` | Opens the page once per minor release in a regular window, deduplicates existing tabs and records `breezer.releaseNotesSeen`. Private windows are excluded. |
| `manifest.json` | Extension version, kept in step with a published release. |

## Template and release workflow

Use [templates/whats-new-release.md](templates/whats-new-release.md) for the authoring template and checklist. The live HTML and CSS are the canonical visual template, so copy their structure rather than maintaining another full stylesheet.

For a new `1.x.0` edition, replace the previous edition's feature and patch content with the new release's illustrated feature rows. Keep the shell, version hooks, actions, accessibility and known-limitations section. Historical editions remain in Git tags and published release evidence. The stable URL stays the same; a new edition does not require another browser route.

For `1.x.1`, `1.x.2` and subsequent patches, append an illustrated patch section to the existing edition. Preserve its earlier changes. Updating `RELEASE_VERSION` automatically derives the same `RELEASE_PAGE_VERSION`, so existing readers do not get a new tab. A user who has never seen that minor edition can still see it once.

Only bump published version metadata as part of preparing an actual release. Page-artwork work alone does not rewrite an already published DMG or authorize a local installation. The user currently requires an explicit request before changing their installed app.

## Page contract

- Load local assets only: system fonts, `icon128.png`, CSS/HTML artwork and inline SVG. No remote fonts, scripts, tracking or requests.
- Keep explanatory artwork `aria-hidden`; put the meaning in adjacent headings and text. Use fictional shapes rather than private browsing or account data. Illustrations explain behavior and are not verification screenshots.
- Keep HTML CSP-safe: external scripts, no inline event handlers or style attributes. Use `textContent` for dynamic text.
- `whats-new.js` accepts only a plain `x.y.z` release string. Missing or malformed metadata falls back to `Breezer` without breaking actions.
- Continue browsing removes the current tab through `chrome.tabs`, then falls back to `window.close()`. If closing is refused, show the close hint. Open Settings is a same-tab link to `workspace.html#/settings`.
- Keep the page light in dark mode. Preserve visible focus, narrow-screen layout and forced-color support. Automatic motion must respect reduced motion.
- The page itself stores nothing. Seen-version storage belongs to `release-notes.js`.
- Describe shipped behavior accurately. Website Touch ID passkeys still require Apple-approved signing entitlements; keep that limitation distinct from password suggestions.

## Verification

From the repository root:

```sh
node --test tests/ai/whats-new.test.mjs tests/ai/release-notes.test.mjs
BREEZER_AI_EVIDENCE=/tmp/breezer-whats-new node --test tests/ai/whats-new-browser.test.mjs
```

The browser fixture uses headless Chrome, synthetic release metadata and a stub for tab-closing APIs. It checks desktop and 390px layouts, contrast, keyboard focus, action fallbacks, reduced motion and malformed metadata. Inspect its full-page screenshots, including every new illustration. Report skips as missing coverage.

These checks do not verify the compiled extension or updater. A release also needs the native build, actual-app checks and artifact verification in [RELEASE_POLICY.md](../RELEASE_POLICY.md). Native acceptance must respect the local-install hold.
