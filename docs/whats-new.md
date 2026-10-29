# What's new page

`features/ai/extension/whats-new.html` is the release notes page for Breezer 1.1.0. It is a single cream paper sheet with a serif title, one breeze stroke that draws once, and four feature rows with small illustrations. Below the features, a note says Touch ID for passwords isn't available yet. The page is always light, even when macOS uses dark mode.

## Integration contract

- **Release info.** The page reads one named export, `RELEASE_VERSION`, from `./release-info.js`, which Main provides. It accepts only a plain `x.y.z` string and shows `Breezer x.y.z` in the masthead and title. A missing file or a malformed value falls back to `Breezer`, and the buttons still work. The page loads the module with a dynamic `import()`, so a missing file can't stop the page script. It doesn't read `RELEASE` or any other export.
- **Feature copy** lives in the HTML and describes 1.1.0. Update it for each release.
- **Opening** the page, including once per release, is up to Main. The page doesn't record that it was seen.
- **Continue browsing** calls `chrome.tabs.getCurrent()`, then `chrome.tabs.remove(id)`. Outside a tab, or if either call fails, it calls `window.close()`. If the page is still open after that, a status line tells the user to close the tab.
- **Open Settings** is a plain link to `workspace.html#/settings` and opens in the same tab.
- **Permissions:** `tabs`, which is already in the manifest. The page needs no new permissions or CSP changes.

## Constraints

- Everything is local: system New York or SF fonts, `icon128.png`, and inline SVG. The page has no remote URLs, `@import`, or `@font-face`.
- Text is set with `textContent` only. The page has no inline scripts, event-handler attributes, or style attributes.
- No storage, network, messaging, or analytics.
- Illustrations are `aria-hidden` and use abstract bars, not sample data. The breeze stroke is the page's only automatic animation, and it plays only when reduced motion is off. The page also handles forced colors, and focus rings are visible.

## Checks

```sh
cd tests/ai
node --test whats-new.test.mjs           # static contract and unit checks
node --test whats-new-browser.test.mjs   # headless Chrome with synthetic release-info.js and a chrome.tabs stub
```

The browser test serves a synthetic `release-info.js`. It checks rendering, contrast of 4.5:1 or better, keyboard order, closing the tab with each fallback, opening Settings in the same tab, motion with reduced motion on and off, a 390 px layout, and missing or hostile release info. It saves screenshots to `$BREEZER_AI_EVIDENCE` (default `/tmp/breezer-ai-evidence`). It doesn't launch the native app.
