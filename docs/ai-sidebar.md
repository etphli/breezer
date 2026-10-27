# Breezer AI sidebar

The first Breezer feature is a contextual assistant in Chromium's native side panel. Press **Command K** on a web page to open or close it. The page chip above the composer shows the current tab. With that chip enabled, sending a message includes the page's text, visible interactive elements, and a screenshot.

The model menu sits below the composer. It lists models returned by the installed, signed-in Codex and Claude CLIs. GPT-6.1 Sol is the default when Codex reports it. Claude uses its own catalog and authentication. Missing CLIs, signed-out accounts, and unavailable models are shown explicitly. Use Refresh after installing or signing in from Terminal.

The reasoning menu beside it lists the selected model's reported effort levels. It starts at High when supported, otherwise the reported default. Default lets the CLI choose when it does not report a default level. Models without adjustable effort show a disabled Default menu. Breezer remembers your choice separately for each provider and model.

Codex also has a Standard / Fast menu. Standard is the initial setting. Fast uses more of your Codex allowance and is enabled only when the model advertises a Fast service tier and the installed CLI passes a local request check. Account eligibility and capacity are checked by Codex when you send; a failed Fast request offers Standard as the retry option. Claude has no speed menu. Model, reasoning, and speed controls are locked during a reply.

The profile button edits your name and personal context. These are saved in this browser and included with messages to the chosen provider. Conversation history is kept in browser session storage per window. It is not synced or retained after the browser session ends.

## Browser control

Enable Browser control before sending a task. The assistant can inspect the page, click visible elements, type into ordinary fields, scroll, press navigation keys, and navigate the controlled tab. During control, a blue outline surrounds the page, an AI pointer identifies actions, and a Stop button stays visible. Stop in the sidebar, Stop on the page, or Escape ends control. The toggle resets after the reply.

Control is limited to one active tab in one browser window. Switching tabs or windows, closing the panel, or losing the debugger connection stops it. Browser control cannot execute arbitrary JavaScript, shell commands, or operating system actions. It does not type into password, payment, token, or one-time-code fields. New tabs, embedded frames, and closed shadow roots are outside this first version's action scope.

An opted-in control task can follow links across HTTP and HTTPS sites in that tab. The debugger connection ends with the task. If it moved to a different site, reopen the sidebar with Command K before asking a new page question so Chromium can grant access to that site.

Normal page questions use Chromium's `activeTab` permission granted by explicitly opening the assistant or sending a message with page context. Automatic tab changes do not grant access. Internal browser pages and private browsing are excluded. Password and recognisable secret fields are omitted from text context and covered during screenshot capture. The rest of the visible page is sent to the selected provider when page context is enabled.

## Implementation

All Breezer additions live outside the imported upstream snapshots:

- `features/ai/extension/` contains the built-in extension, native-panel UI, worker, and bounded browser tools. Production UI has no third-party JavaScript dependencies.
- `features/ai/host/` contains the length-prefixed native-messaging host and provider adapters. It launches only discovered Codex or Claude executables, with arguments passed directly to child processes.
- `features/ai/integration/` fixes the extension identity and exact native-host origin. The host is resolved inside the application bundle, so moving Breezer does not leave a stale registration path.
- `script/apply_breezer_ai.py` applies the component resources, native Command K binding, and bundled host lookup to prepared Chromium after upstream patches and Breezer branding.
- `script/package_breezer_ai.py` packages the host and a checksum-verified Node runtime before app signing. `features/ai/runtime.lock.json` pins the runtime archives; the bundle includes Node's licence.

There is no privileged localhost service. Chromium communicates with the helper through a private stdio pipe restricted to the built-in extension origin. Page content and provider output are treated as untrusted data. Provider credentials stay with their CLIs and are never exposed to web pages or the sidebar.

Codex uses its app-server protocol in an isolated configuration with only its authentication file reused. Before inference, a credential-free loopback probe verifies the actual model tool registry contains exactly the permitted Breezer tools. An unexpected tool disables the turn. This temporary probe only receives a synthetic inference request; it cannot perform browser or system actions. Claude runs with built-in tools, hooks, plugins, external MCP servers, and Chrome integration disabled. Its structured response requests a browser action, waits for the extension's result, and continues the turn.

Codex reasoning maps to `turn/start.effort`; speed maps to `turn/start.serviceTier`, using the model's advertised Fast tier ID or explicit `default` for Standard. Only Fast enables the CLI's `fast_mode` feature. The isolation probe uses the same effort and tier as the real turn and checks their outgoing request values as well as the tool registry. It accounts for the CLI's reported effort mapping: GPT-6.1 Sol currently serializes Ultra as `xhigh`. Browser-only restrictions still apply at every effort level. Claude reasoning maps to its `--effort` argument; no Codex speed setting is passed to Claude.

The adapters were exercised with Codex CLI 0.163.0 and Claude Code 2.1.309. Future CLI changes can make a provider unavailable until its protocol or isolation options are updated. Codex currently reuses auth-file login; a keychain-only installation may need a normal `codex login` before the isolated helper can authenticate.

## Checks

Run the host and browser-policy tests without an account or browser:

```sh
node --test tests/ai/*.test.mjs
python3 tests/ai/overlay_test.py
python3 script/check_ai_packaging.py
```

Check the patch against real pinned Chromium sources plus both Helium patch series:

```sh
python3 script/check_ai_overlay.py
```

Pass `--offline` to reuse downloaded fixtures. Pass `--grit-directory path/to/chromium/tools/grit` to additionally build the real resource PAK and generated C++ resource map.

Run the shipped UI and browser actions in Chromium:

```sh
npm ci --prefix tests/ai
npx --prefix tests/ai playwright install --with-deps chromium
node tests/ai/panel-browser.mjs
node tests/ai/browser-page.mjs
```

The browser checks use Chrome on macOS and Playwright Chromium elsewhere. Set `BREEZER_TEST_BROWSER` for another executable. Screenshots are saved to `/tmp/breezer-ai-evidence`, or `BREEZER_AI_EVIDENCE` when set. These tests render the real sidebar and drive real trusted browser input, while supplying a deterministic extension-API fixture. They do not represent a compiled Breezer app.

Read-only discovery through actual native-messaging frames:

```sh
node tests/ai/host-discovery.mjs
```

Check the installed CLIs' reasoning and speed arguments without paid inference:

```sh
node tests/ai/host-options.mjs
```

This checks Codex's actual outgoing request against a credential-free local server, including Standard, Fast, High, and Ultra when reported. It also checks that Claude accepts its reported effort argument during initialization. It does not verify account eligibility for paid Fast requests.

Optional live checks use the signed-in provider and incur a small inference request. Each supplies only synthetic page data and performs one snapshot round trip:

```sh
node tests/ai/host-live.mjs --run-live codex
node tests/ai/host-live.mjs --run-live claude
```

Both live checks passed during implementation: GPT-6.1 Sol and Claude Opus 5.5 streamed replies, requested a snapshot, waited for the returned result, and completed. Native Command K, component loading, app-bundle host discovery, and browser signing still require validation in a compiled Breezer build. Local native compilation was blocked by Xcode's outstanding licence acceptance.

## References

- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Chromium side-panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chromium native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chromium debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Comet quick-start guide](https://www.perplexity.ai/comet/resources/articles/comet-quick-start-guide), interaction reference for page context and visible control
