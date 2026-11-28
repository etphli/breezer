# Breezer 1.3.7 draft notes

These notes collect fixes for the patch after 1.3.6. The bundled update page keeps the 1.3.0 seen-version key.

## Browser interface

- Settings centers the heading and content in the pane beside the category list.
- The floating sidebar opens with rounded corners and a gap around it. The footer uses compact controls and a transparent background around the space icons.
- The sidebar address experiment lets you search and edit URLs in place. It shows the start of long addresses and hides the top bar during browsing.
- Settings has a wider AI model selector with taller options and visible provider headings.

## New Tab

- Search suggestions stay visible and clickable when they overlap the Organato section.

## Breezer AI

- When the model sends a browser action with bad arguments, such as an address without `https://`, Claude now sees the error and can try again. The chat no longer ends with "Invalid URL".
- A browser action that finishes after the helper's time limit no longer stops the chat on screen while it keeps running in the background. Your next message no longer fails with "Another chat is already running".
- If the local helper fails to load the chat engine, the chat shows an error instead of spinning.
- Scrolling now covers the full distance the assistant asks for.
- A very long reply no longer blocks the rest of the conversation. Breezer shortens older messages before sending them.
- Research no longer fails when masked secrets land at the source length limit, and it no longer waits forever when a selected tab closes or crashes during reading.
- When the assistant replaces text in a field, Breezer checks again that the same field still has focus before typing.
- Saved conversations keep their newest images within a size budget, and Breezer tells you if a conversation could not be saved.
- A background error, such as a failed model refresh, no longer marks the running reply as failed.
- While a page is shared, the assistant can read Organato tasks but can't create or change them. With Browser control on, it can't use Organato at all. This stops page text from changing or leaking your tasks.
- When Claude retries an answer, the chat shows and saves the final answer instead of the first attempt.
- Codex replies made of several messages keep a blank line between them, so headings and lists render.
- Dashes and other non-English characters in the Codex model list are no longer garbled.

## Sidebar and favorites

- Undo after unpinning or removing a favorite now survives workspace sync and keeps a pin's custom name.
- Undo no longer pushes favorites past 12 or silently drops the newest one.
- Dragging a pinned or favorite tab into another open window keeps it linked to its saved entry.
- Undo after Clear Today restores every closed tab, including repeated pages.
- When the sidebar's page crashes or closes, the tab list takes the whole sidebar instead of sharing it with an empty band.
- Cmd+1 to Cmd+8 still switches tabs if the sidebar stops responding.

## Updates

- A worker that was force-quit or lost power during an update no longer blocks future in-app updates. If another update really is running, Breezer says so instead of reporting that macOS may have blocked it.
- Breezer removes the downloaded disk image even when macOS refuses to eject it, and cleans up leftovers from earlier failed updates. It keeps only the most recent in-app update backup and leaves manually made backups alone.
- A failed update always reports a final status instead of leaving Settings on "downloading". An update that is still running keeps its lock, even after the Mac sleeps.

## Sync

- A device joining sync waits for the saved workspace to download, so it no longer replaces your customised spaces and theme with defaults.
- A title or name cut inside an emoji no longer stops workspace sync.
- A theme locked by your organisation no longer makes sync repeat continuously.
- An appearance change made while sync is running is no longer undone.
- A profile restored from a backup no longer gets stuck on "Conflicting workspace clock".
- A default space you deleted before your first sync no longer comes back when another device joins.

## Settings and New Tab

- Choosing Standard after a personality keeps a colour you picked since.
- Quickly switching personalities keeps the last one you chose.
- Organato and AI memory consent switches go back to their real state when a change fails, so a failed consent revoke no longer looks revoked.
- AI memory counts visits by your local calendar day.
- New Tab shows a date instead of a weekday for chats from about a week ago.
- New Tab suggestions use the browser's 8,192-byte limit, so long non-English text no longer sends requests the browser refuses.

## Organato

- An impossible deadline such as month 13 now gets the normal "Use a valid YYYY-MM-DD deadline." message.

- A very large Organato list no longer crashes the local helper. Breezer shows the most relevant items and marks the list as shortened.

## Windows

- The AI sidebar's local helper accepts the window argument Chromium adds when it starts the helper on Windows, so the sidebar can connect. Before publishing, open the sidebar on a packaged Windows build and confirm that a chat starts.

## Developer and site fixes (not user-facing)

- `script/build_and_run.sh` honors `build/local-update-hold.json`. It quits only the build it manages, waits for Breezer to exit before replacing it, and `--verify` checks the expected app path.
- The usage dashboard keeps working when report storage exceeds its listing cap and marks its figures as partial, including when reading reports would exceed its time budget. Retention still removes expired reports at that volume. Configure a Vercel Firewall rate limit for `/api/usage` separately.
- The dashboard caches GitHub download counts and uses `GITHUB_TOKEN` when it is set in Vercel.
- The dashboard reads every month in its 30-day window, so it no longer skips February on March 1.
- Usage reports wait 30 minutes after a failed send too, as the privacy policy says.
- Build tooling:
  - `install_breezer.py` honors the local update hold.
  - Development runs use `build/dev-profile` unless `BREEZER_USE_REAL_PROFILE=1` is set.
  - Builds with uncommitted changes are marked dirty and cannot publish an update manifest.
  - The macOS CI cache covers every overlay input, and Windows rebuilds refuse changed overlays.
  - More test suites run in CI.
  - Compiled-filter staging refuses source trees it can't hook cleanly instead of leaving them failing `--check`.
  - The AI overlay check refuses a Chromium version other than the reviewed pin and caches per version.
- Exit-time cleanup of code-signing clones waits briefly for a busy lock instead of skipping.
