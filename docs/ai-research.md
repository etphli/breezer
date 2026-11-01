# Selected-tab research

In the assistant, choose **Choose source tabs**, select up to six HTTP or HTTPS pages in the current window, then choose **Done**. Tab and Space work with the checkboxes; Escape closes the picker. Source chips identify each selected page and remove it when pressed. **Clear sources** returns to the normal active-page mode.

The sharing hint says exactly what will be sent. While sources are selected, sending shares their text with the chosen Codex or Claude provider, with no screenshots, active-page context or browser control. Ask for a comparison, summary or synthesis. Sources are labeled `[S1]`, `[S2]` and so on; the provider is instructed to cite those labels. The user message records the titles, URLs, capture lengths, truncation and individual failures. Citation quality still depends on the model.

Each source captures at most 24,000 characters of rendered top-level text, scanning at most 40,000 text nodes. Content below the viewport can be included; embedded frames, form values, editable content, hidden nodes and recognized secret fields are excluded. Recognizable token/key strings and labeled secrets are redacted. This cannot identify every secret in ordinary prose. Query strings and fragments are removed from provider source URLs. An unavailable source contributes only its label, URL and error, never replacement content. A request with no available text fails locally.

Loading sources are disabled in the picker. Reopen it when loading finishes. Navigation, including same-URL reloads, closing or moving a source, switching active tabs or browser windows, or hiding the assistant clears selection and stops a research response. Removing or clearing sources during a response also stops it. Stop and Escape cancel pending capture and discard late results. Captured source bodies and native read grants are not saved. The existing conversation transcript remains in session history and can contain quoted source material in replies. Follow-ups read the selected documents again only when the user sends.

## Permission boundary

`breezerPrivate.getResearchTabs()` returns metadata for eligible top-level tabs in the caller's own non-private window. It reads no page text. `readResearchTab(tabId, documentId, expectedUrl)` requires a user gesture from the built-in extension's `/panel.html`, and checks that exact tab, document and URL in that same window. It runs only `research_text.h`'s fixed isolated-world reader. It rechecks document lifetime, URL, window membership and loading state when the result arrives and times out after eight seconds.

Neither method grants `activeTab`, host permissions, scripting permission or debugger access. The extension's ordinary active-tab grants and browser-control consent are unchanged. Research and control are mutually exclusive. The host validates a separate bounded source array, treats it as untrusted data, and exposes no browser tools for research to either provider. A page's instructions cannot add tools or select another tab.

The background accepts source submissions only from its own panel document. It matches the submission to the explicit capture draft, checks current tab metadata, strips internal tab/document identifiers, and rejects invalidated drafts. Source navigation and cancellation invalidate pending work before provider dispatch. Model discovery and provider isolation use the existing host paths.

## Verification

- `node --test tests/ai/research.test.mjs tests/ai/research-providers.test.mjs` checks source selection, partial failures, worker permissions and revocation, prompt formatting in both actual adapters with deterministic CLI fixtures, and native guard source invariants.
- `node tests/ai/research-browser.mjs` exercises the shipped panel/picker in real Chromium with a deterministic extension API fixture and runs the exact native reader script in real DOM documents. It saves `research-selected-tabs.png`, `research-picker.png` and `research-partial-failure.png` to `BREEZER_AI_EVIDENCE` or `/tmp/breezer-ai-evidence`.
- `node tests/ai/panel-browser.mjs` checks the existing single-tab flow.
- `python3 script/check_ai_overlay.py` and `python3 script/check_breezer_workspace.py` validate source/resource overlays against pinned Chromium and Helium fixtures. The IDL also parses and generates C++ with Chromium's pinned schema compiler.

These are source, fixture and real-renderer script checks. They do not verify a compiled Breezer side panel, native API dispatch/gesture propagation, actual native window/document lifetime behavior, signing or live provider answers. No verified disposable compiled browser was available during implementation; the release coordinator's frozen PC build predates this branch. Those native acceptance checks require a later combined build with disposable profiles. No installed app, personal profile, shared build cache or paid provider was used.
