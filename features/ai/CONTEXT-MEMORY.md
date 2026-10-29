# Opt-in context and habits

This change supplies new modules only. Main must apply the integration below after the other workers finish. No shared file has been edited. Ordinary chats keep their existing page-sharing and control switches. Stored activity and generated summaries are never attached to ordinary chats automatically.

## Behavior and privacy

- Local context starts off. Users must enable it and enter 1–20 exact public hostnames. Subdomains are separate.
- An observation requires an active, explicitly non-incognito tab, a matching allowed hostname, and a current page grant. The adapter checks the grant and re-reads the tab before writing. No new permission is granted by this feature.
- Only hostname, UTC day, daily count and the latest half-hour slot are stored. No tab titles, page text, DOM, screenshots, form contents, URL paths, credentials, query strings, fragments or full URLs enter the store or provider payload. The path is inspected only to reject known sensitive routes, then discarded.
- Local-address literals, known private/internal host suffixes, credentialed URLs, and known auth, account, mail, financial and health routes are excluded. This filter is conservative, not a classifier for every sensitive website. The explicit site list is the primary scope control. Site names themselves can reveal information.
- Each site contributes at most one sample per UTC half-hour slot, not a page-view count or time-spent measurement. Storage has at most 140 daily buckets for 20 sites over 7 UTC calendar days. Expired buckets are removed at worker startup and every read before use. No cleanup runs while Breezer's worker is dormant; physical deletion happens at its next startup or context operation.
- Suggestions are deterministic local text, marked as possible preferences. No browsing event starts a provider or model request.
- A separate unchecked consent control explains that manual summaries send selected site names and aggregate counts to OpenAI through the signed-in Codex CLI. The displayed table previews those fields. A manual request requires at least 3 samples and is limited to once per hour with changed data. Attempts reserve the cooldown even if discovery or inference fails. No automatic retry, paid fallback or per-event inference is performed.
- The only configured model is `gpt-6-luna`. It must also be present in the authenticated provider's discovered account models. Standard speed is enforced; `low` reasoning is selected only if advertised, otherwise the provider's reported default applies. If Luna is absent, the helper returns a local-only notice. The existing chat model is never substituted.
- Provider summaries have no page context, profile, chat history, or browser tools. Input is labelled untrusted data and site names must never be treated as instructions. Inferences are visibly labelled. Provider text is rendered as text, never HTML or actions, and is not persisted.
- Clear erases learned activity and revokes provider consent while preserving the local enable/site choice. Disable erases all local context state, including the site list. Either action, consent revocation, Stop, settings disconnection, host cancellation or disposal cancels requests and suppresses late output. Already-transmitted provider data cannot be recalled.

## Provider evidence

On 2026-10-29, using this checkout's existing `findCli` and `runCli` from `host/cli.mjs`, `codex debug models` exited 0. Its catalog reported:

```json
{"slug":"gpt-6-luna","display_name":"GPT-6-Luna","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"}]}
```

The live T3 `orchestrator_capabilities` catalog independently listed `gpt-6-luna` for provider `codex`. T3 availability is not used as proof of Breezer account access. Breezer's existing `CodexProvider.discover()` intersects the CLI catalog with `model/list`; `contextSummaryModel()` requires that discovered list and authenticated/available status at request time. No authenticated inference, native build or app/browser launch was performed for this change.

## Integration for Main

Apply these additions once, after merging the AI-input and settings workers. Keep their final behavior and adjust the anchors if they moved. All referenced files ship automatically with the existing extension/host directory packaging; no manifest permission or native patch is needed.

### 1. Background registration and existing grant hooks

Add this import to `extension/background.js`:

```js
import { installContextBackground } from './context-background.js';
```

Inside `installBackground(api)`, immediately after constructing `tools`, add:

```js
const contextMemory = installContextBackground(api, {
  isPermitted(tab) {
    try {
      return tab?.incognito === false
        && tools.grants.get(tab.id) === new URL(tab.url).origin;
    } catch { return false; }
  },
});
```

Keep the original authorization code. Immediately after `tools.authorize(tab)` in `toggle`, add:

```js
void contextMemory.observeGranted(tab);
```

Immediately after each existing `await tools.verifyGrant(tab)` in `currentPage` and the panel `init` branch, add the same line. `observeGranted` does not grant access: it rechecks the grant and current tab, local opt-in and the site allowlist. These hooks capture the first sample after an explicit grant; tab activation/navigation events handle later samples. Native Cmd+K grants therefore work too. With context off, these calls collect nothing. Never call `tools.authorize` merely to feed memory.

Optionally expose `contextMemory` in the background's existing returned test/disposal object. If that object gains a disposal method, call `contextMemory.dispose()` there. Install only once in the extension service worker, never from each settings page.

### 2. Native host adapter

In `host/main.mjs`, replace only its controller import:

```diff
-import { HostController } from './controller.mjs';
+import { ContextHostController as HostController } from './context-controller.mjs';
```

Leave the constructor call and native transport unchanged. This adds `context-summary` handling around the final shared `HostController`; it inherits ordinary chat, discovery, tool validation and shutdown. No changes to `host/controller.mjs` are needed. Do not wire summaries through ordinary `chat` messages or saved profile instructions.

### 3. Settings entry

Context settings styles are included in `workspace.css` to stay within the existing 20-resource allocation.

Add a placeholder in the settings content, for example immediately after `password-settings`:

```html
<div id="context-settings"></div>
```

In `extension/settings.js`, add:

```js
import { mountContextSettings } from './context-settings.js';
```

Inside `mountSettings`, after the existing `mountPasswords` call, add:

```js
const contextSettings = mountContextSettings({ container: $('context-settings'), api });
window.addEventListener('pagehide', () => contextSettings.dispose(), { once: true });
```

If the settings worker introduces a route cleanup callback, register `contextSettings.dispose()` with that callback instead. The module has native checkbox labels, a hostname field, local save/disable/clear controls, a local activity table and suggestions, separate provider consent, a manual summary button and Stop. It uses existing settings classes and the small scoped stylesheet. No new sidebar layout or global CSS rule is required.

## Verification

Before implementations existed, the new storage/summary tests failed with `Opt-in local context storage is missing` and `Consent-bound lightweight summarization is missing`. The adapter and settings suites likewise failed before their modules were added. During review, three additional tests reproduced actual defects before their fixes: replacement chat rejected after cancellation, cancellation waiting on an uncooperative sender, and duplicate aggregate data in the summary fingerprint. All now pass.

Focused checks:

```sh
node --test tests/ai/context-memory.test.mjs tests/ai/context-integration.test.mjs tests/ai/context-settings.test.mjs
```

23 tests passed. These include an end-to-end local adapter test using the actual memory, native transport handler and host wrapper with a stubbed provider, plus a Node DOM event harness for the local enable/separate provider consent/summary/disable flow. No model inference or browser is used.

Adjacent checks:

```sh
node --test tests/ai/context-memory.test.mjs tests/ai/context-integration.test.mjs tests/ai/context-settings.test.mjs tests/ai/host.test.mjs tests/ai/browser-tools.test.mjs tests/ai/model-catalog.test.mjs tests/ai/panel-theme.test.mjs tests/ai/workspace-store.test.mjs tests/ai/workspace-static.test.mjs
```

107 tests passed. Syntax checks for all new JavaScript modules and `git diff --check` also passed.

Main must verify the final merged import/hooks, rendered settings, permissions in the real extension, native packaging and one separately consented inference if authorized. This work deliberately did not run browser/native/installed-app checks, timed benchmarks or publication. It does not promise broad semantic preference learning, continuous screen observation, historical browsing import, cross-device sync or automatic personalization of chat.
