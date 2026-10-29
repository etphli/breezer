# Sidebar and themes

Breezer's workspace uses custom tabs on the left, bookmarks across the top, and an assistant on the right. Chromium manages the real tabs, navigation, pinned state, and session restore.

## Use the sidebar

Click **New tab** or press Command T to create a page. Click a row to switch pages. Close a row with its close button or a middle click. Right-click a row for pin, folder, and move actions. Drag rows to reorder them.

Use the dots at the bottom to switch spaces. Control 1 through Control 4 selects the first four spaces on macOS. A space filters the sidebar's tab list; its other tabs remain open in the browser. Favorites appear in every space. Saved pins and folders remain available after their live tabs close.

Open **Settings** from the sidebar footer, choose **Settings** from the browser menu, or press Command comma. The full-page settings screen provides:

- Sidebar or top tabs.
- Expanded sidebar, compact icons, or auto-hide with reveal from the left edge.
- Mint, Tide, Dusk, Rose, Pollen, and Graphite themes.
- System, light, or dark appearance.
- Bookmark bar visibility and sidebar width.
- Sidebar font size from 12 to 20 pixels.
- Centered address bar, minimal URL, and loading progress.
- Frameless mode, with separate switches to keep the sidebar and top bar visible.
- Space names, colors, and order.
- New-tab placement and close-button behavior.

On first visit, a **Bring your Chrome data to Breezer** card sits above the settings. **Import bookmarks and history** opens the native import dialog (`chrome://settings/importData`), where an installed Google Chrome can be chosen as the source for bookmarks and history. **Show password steps** expands the Chrome CSV guide in Passwords. The card never reads Chrome files or credentials and never reports that an import succeeded; the user checks results in the native pages. **Hide** stores `{ dismissed: true }` under `settings.onboarding.v1` in `chrome.storage.local`, and open Settings tabs hide the card too. After that, the browser import stays in **More browser settings** and the password guide stays in **Passwords**.

Appearance choices apply to the profile. Space colors identify spaces within the sidebar. The **More browser settings** section opens native categories, including page fonts, search, privacy, site permissions, autofill, downloads, accessibility, and system settings. **All native browser settings** opens `chrome://settings/` directly. The browser menu, Command comma, and general native Settings actions open the workspace hub when its component extension is enabled. Native category routes and the fallback for builds without the extension remain available.

Space membership is restored by matching saved URLs when the match is unambiguous. If identical restored URLs belonged to different spaces, Breezer keeps the pages open in the default space rather than assigning another window's saved membership.

## Use the assistant

Press Command K to toggle the assistant. Its close button is inside the assistant's own toolbar. The extra Chromium title, pin, and close header is hidden for Breezer AI.

Sending with page context enabled grants access to the active HTTP or HTTPS page. Automatic tab changes do not grant page access. Browser control stays scoped to the current request and stops when you cancel, close the panel, or switch the controlled tab.

The model picker uses the account CLI's model catalog and shows the newest reported release in each model family. Terra appears when the Codex account reports it. Reasoning and Codex speed choices remain per model.

## Appearance contract

`getAppearance` returns the current profile appearance. `setAppearance` accepts a nonempty patch of the declared fields. Unknown keys, invalid types, out-of-range values, or a field that the user cannot modify reject the entire patch before any writes. Both methods remain restricted to Breezer's component extension and regular profiles.

`sidebarFontSize` is an integer in pixels, default `15`, inclusive range `12..20`. Native storage is `breezer.workspace.sidebar_font_size`. The IDL, native constants, JavaScript validator, fallback appearance, and settings typography control share these bounds. Invalid stored native values are clamped on read. JavaScript treats malformed bridge values as the default. Changes publish the existing `appearance.rev` session notification so sidebar consumers can reload appearance.

The additional boolean fields map to fixed native preferences:

- `centeredAddressBar`: `helium.browser.centered_location_bar`, default `true`.
- `minimalUrl`: `helium.browser.minimal_location_bar`, default `true`.
- `showLoadProgress`: `helium.browser.show_progress_bar`, default `true`.
- `frameless`: `helium.browser.zen_mode`, default `true`.
- `alwaysShowSidebar`: `helium.browser.zen_mode_sidebar_pinned`, default `false`.
- `alwaysShowTopBar`: `helium.browser.zen_mode_top_chrome_pinned`, default `true`.

Fresh profiles start with vertical tabs on the left. `sidebarMode` keeps its existing `expanded`, `compact`, and `autoHide` values. Selecting `autoHide` continues to set `kVerticalTabsExpandOnHoverEnabled`. The disabled-looking native auto-expand switch does not define a new default. Frameless sidebar pinning is independent of `sidebarMode`.

The migration records `breezer.workspace.appearance_defaults_version = 2`. It preserves explicit saved preferences, managed or extension-controlled values, and custom themes. The old `breezer.workspace.initialized` marker prevents reapplying v1 layout, bookmark, width, and theme defaults. Version 2 initializes the new boolean defaults only where no explicit preference exists, then records completion. Font size uses its registered default, so existing explicit font sizes remain intact.

## Verify settings

`node --test tests/ai/workspace-store.test.mjs tests/ai/workspace-static.test.mjs` checks JavaScript bounds and static safety. The existing `tests/ai/workspace-browser.test.mjs` drives the shipped page with a deterministic browser API fixture. `python3 -B script/check_breezer_workspace.py --no-cache` downloads a pinned source fixture into temporary storage and checks overlay application, idempotence, interrupted application, and anchor drift without reading or writing the shared cache.

Native behavior requires a compiled Breezer app. `tests/ai/workspace-native.mjs` checks v1 saved choices by default. `BREEZER_TEST_FRESH_PROFILE=1` selects fresh defaults. Its settings checks include font boundaries and rejected mixed patches. Browser fixture and source checks do not prove native compilation, live policy enforcement, or window geometry.

## Source layout

The workspace documents ship inside the built-in Breezer extension. A native view hosts one document per browser window. Ordinary `chrome.tabs` calls operate on Chromium's tab model; extension storage records spaces, folders, and favorites.

The private `chrome.breezerPrivate` API exposes bounded appearance choices and explicit current-page authorization. It accepts no arbitrary preference names, scripts, or destination window IDs. The extension retains its existing `activeTab` permission.

The workspace and assistant native overlays have separate preparation fingerprints. A first application keeps `out/`; a matching fingerprint verifies the installed source. A changed fingerprint refuses reuse until an explicit migration has been verified. Imported upstream source and tests remain intact.

The bookmarks bar defaults to **New tabs only**, including Breezer’s new-tab page and `about:blank`. Settings also offers **Always** and **Hidden**. The native bridge uses Chromium’s `bookmark_bar.visibility_state`; its older `showBookmarks` boolean remains a compatibility alias.
