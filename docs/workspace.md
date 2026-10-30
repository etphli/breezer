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

## First-run setup

A brand-new profile opens the setup guide at `workspace.html#/welcome` instead of the release notes. `release-notes.js` treats a profile as new when it has no `breezer.releaseNotesSeen`, no `breezer.setup.v1`, no `settings.onboarding.v1` and no `breezerProfile`; it records the current notes version at the same time, so the notes page does not follow. Profiles used before 1.2.0 keep getting the notes page once per minor release.

The guide has eight steps: welcome, the name Breezer AI calls you, tab layout and sidebar behavior, theme and appearance, Chrome import, Organato, a tour and a summary. Each choice is saved where Breezer already reads it:

- The name goes into `breezerProfile.name`, keeping any saved profile context. An open assistant panel updates its greeting through `storage.onChanged`.
- Layout, sidebar behavior, theme, custom color and appearance go through `breezerPrivate.setAppearance`, one write at a time, and bump `appearance.rev` so sidebars and the panel repaint. The page itself repaints with the chosen tone. Without the native bridge the controls are disabled and a note explains why.
- Import buttons open `chrome://settings/importData` and `chrome://password-manager/settings?import=true`. The guide never reports that an import succeeded.
- The Organato key goes to the background helper over the existing `breezer-organato-settings` port, which stores it in Keychain. Organato is optional; Continue skips it.

The tour has three sidebar slides (tabs, favorites and spaces, Settings) or one top-tab slide, followed by two assistant slides (⌘K and Browser control). A miniature Breezer window beside the copy reflects each choice and points at the part being explained. Its motion stops under Reduce motion and it is hidden in forced-colors mode.

`breezer.setup.v1` stores only `{ step, completed, skipped }`, so a closed guide resumes where it stopped. **Start browsing** marks setup complete, hides the Settings import card, and turns the tab into a new tab rather than closing the only window. **Skip setup** records a skip and leaves the import card in Settings. **Setup guide** in the Settings header reopens the guide at any time. Its stylesheet, `onboarding.css`, loads only on this route.

`tests/ai/onboarding-browser.test.mjs` walks the guide in headless Chrome, including keyboard selection, the top-tab tour, Skip, a missing bridge and a 390 px layout. Set `BREEZER_ONBOARDING_VIDEO=/some/dir` to record the walkthrough at a human pace; Playwright needs its ffmpeg helper (`npx playwright install ffmpeg` in `tests/ai`). Native first-run behavior still needs a compiled app with a fresh profile.

## Chrome import card

On first visit, a **Bring your Chrome data to Breezer** card sits above the settings. **Import bookmarks and history** opens the native import dialog (`chrome://settings/importData`), where an installed Google Chrome can be chosen as the source for bookmarks and history. **Show password steps** expands the Chrome CSV guide in Passwords. The card never reads Chrome files or credentials and never reports that an import succeeded; the user checks results in the native pages. **Hide** stores `{ dismissed: true }` under `settings.onboarding.v1` in `chrome.storage.local`, and open Settings tabs hide the card too. After that, the browser import stays in **More browser settings** and the password guide stays in **Passwords**.

Appearance choices apply to the profile. Space colors identify spaces within the sidebar. The **More browser settings** section opens native categories, including page fonts, search, privacy, site permissions, autofill, downloads, accessibility, and system settings. **All native browser settings** opens `chrome://settings/` directly. The browser menu, Command comma, and general native Settings actions open the workspace hub when its component extension is enabled. Native category routes and the fallback for builds without the extension remain available.

Space membership is restored by matching saved URLs when the match is unambiguous. If identical restored URLs belonged to different spaces, Breezer keeps the pages open in the default space rather than assigning another window's saved membership.

## Peek from favorites

A favorite keeps its saved title and icon while its tab browses. Its tile does not take on the live page's title or icon.

A link from a favorite's live tab that would open a new tab opens in a **peek** instead. The live page shows in a centered, roughly square card above a tinted backdrop. The compact toolbar shows the site, an expand icon and Close. **Expand** moves the same live page, with its scroll position, form input, and history, into an ordinary tab. Escape, the close button, a click on the backdrop, the page closing itself, or switching tabs closes the peek and discards the page. The backdrop and then the card fade in over about 200 ms; the fade is skipped when macOS Reduce motion is on. Only opacity animates, so clicks land on the page where it is drawn from the first frame.

The exact triggers, all only from a favorite's tab while it is the visible tab:

- A user-clicked link or `window.open()` that would open a foreground tab (for example `target="_blank"`), from any site.
- Command Shift click on a link (foreground tab).
- A user-activated link or scripted GET navigation to a different HTTP(S) page, including a document or subject on the same site. The favorite stays on its page and the destination opens in a peek. Initially blank foreground windows are supported so a script can navigate the new page after creating it.

These keep their usual behavior: Command click and middle click (background tab), Shift click (new window), the link context menu, the address bar, back and forward, reloads, form submissions, script navigations without user activation, same-document app routes and fragment changes, pinned tabs, today tabs, and private windows.

A peek is a real browser page. It is not a frame, and it keeps the site's own security checks, certificate errors, and Safe Browsing warnings. Before Expand, permission prompts, JavaScript dialogs, file pickers, and fullscreen are declined. Links that a peeked page opens in new tabs open as ordinary tabs.

The sidebar sends the live favorite tab IDs for its own window through `breezerPrivate.setPeekSources(tabIds)`. The browser marks those tabs and clears every other tab in that window. Removing a favorite or closing its tab clears the mark on the next update.

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

`tests/ai/workspace-peek.test.mjs` checks peek-source syncing and saved favorite identity in the sidebar fixture. `script/check_breezer_workspace.py` checks the Peek source hooks, trigger conditions and the opacity-only, reduced-motion-aware entrance. `node tests/ai/peek-native.mjs /path/Breezer.app` drives the compiled app. App-owned native UI DevTools exercises Expand, Close, the backdrop and root Escape. Physical macOS pointer routing and focused-page keyboard dispatch remain unverified. Same-site and scripted-creation fixtures are required for the 1.1.3 candidate; authenticated Google Docs and Canvas/Reshet workflows require separate acceptance.

Native behavior requires a compiled Breezer app. `tests/ai/workspace-native.mjs` checks v1 saved choices by default. `BREEZER_TEST_FRESH_PROFILE=1` selects fresh defaults. Its settings checks include font boundaries and rejected mixed patches. Browser fixture and source checks do not prove native compilation, live policy enforcement, or window geometry.

## Source layout

The workspace documents ship inside the built-in Breezer extension. A native view hosts one document per browser window. Ordinary `chrome.tabs` calls operate on Chromium's tab model; extension storage records spaces, folders, and favorites.

The private `chrome.breezerPrivate` API exposes bounded appearance choices and explicit current-page authorization. It accepts no arbitrary preference names, scripts, or destination window IDs. The extension retains its existing `activeTab` permission.

The workspace and assistant native overlays have separate preparation fingerprints. A first application keeps `out/`; a matching fingerprint verifies the installed source. A changed fingerprint refuses reuse until an explicit migration has been verified. Imported upstream source and tests remain intact.

The bookmarks bar defaults to **New tabs only**, including Breezer’s new-tab page and `about:blank`. Settings also offers **Always** and **Hidden**. The native bridge uses Chromium’s `bookmark_bar.visibility_state`; its older `showBookmarks` boolean remains a compatibility alias.
