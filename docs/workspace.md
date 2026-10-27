# Sidebar and themes

Breezer's workspace uses custom tabs on the left, bookmarks across the top, and an assistant on the right. Chromium manages the real tabs, navigation, pinned state, and session restore.

## Use the sidebar

Click **New tab** or press Command T to create a page. Click a row to switch pages. Close a row with its close button or a middle click. Right-click a row for pin, folder, and move actions. Drag rows to reorder them.

Use the dots at the bottom to switch spaces. Control 1 through Control 4 selects the first four spaces on macOS. A space filters the sidebar's tab list; its other tabs remain open in the browser. Favorites appear in every space. Saved pins and folders remain available after their live tabs close.

Open **Sidebar and theme settings** from the sidebar footer, choose **Settings** from the browser menu, or press Command comma. The full-page settings screen provides:

- Sidebar or top tabs.
- Mint, Tide, Dusk, Rose, Pollen, and Graphite themes.
- System, light, or dark appearance.
- Bookmark bar visibility and sidebar width.
- Space names, colors, and order.
- New-tab placement and close-button behavior.

Appearance choices apply to the profile. Space colors identify spaces within the sidebar. Existing browser settings remain available through links in the settings page.

Space membership is restored by matching saved URLs when the match is unambiguous. If identical restored URLs belonged to different spaces, Breezer keeps the pages open in the default space rather than assigning another window's saved membership.

## Use the assistant

Press Command K to toggle the assistant. Its close button is inside the assistant's own toolbar. The extra Chromium title, pin, and close header is hidden for Breezer AI.

Sending with page context enabled grants access to the active HTTP or HTTPS page. Automatic tab changes do not grant page access. Browser control stays scoped to the current request and stops when you cancel, close the panel, or switch the controlled tab.

The model picker uses the account CLI's model catalog and shows the newest reported release in each model family. Terra appears when the Codex account reports it. Reasoning and Codex speed choices remain per model.

## Source layout

The workspace documents ship inside the built-in Breezer extension. A native view hosts one document per browser window. Ordinary `chrome.tabs` calls operate on Chromium's tab model; extension storage records spaces, folders, and favorites.

The private `chrome.breezerPrivate` API exposes bounded appearance choices and explicit current-page authorization. It accepts no arbitrary preference names, scripts, or destination window IDs. The extension retains its existing `activeTab` permission.

The workspace and assistant native overlays have separate preparation fingerprints. A first application keeps `out/`; a matching fingerprint verifies the installed source. A changed fingerprint refuses reuse until an explicit migration has been verified. Imported upstream source and tests remain intact.
