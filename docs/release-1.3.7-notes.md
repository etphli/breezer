# Breezer 1.3.7 draft notes

These notes collect fixes for the next patch after 1.3.6. Nothing here is published yet. When the 1.3.7 release is prepared, append an illustrated `patch-137` section to `features/ai/extension/whats-new.html` after the 1.3.6 section, following [whats-new.md](whats-new.md). Patches keep the 1.3.0 seen-version key and do not open another tab.

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

## Sidebar and favorites

- Undo after unpinning or removing a favorite now survives workspace sync and keeps a pin's custom name.
- Undo no longer pushes favorites past 12 or silently drops the newest one.
- Dragging a pinned or favorite tab into another open window keeps it linked to its saved entry.
- Undo after Clear Today restores every closed tab, including repeated pages.

## Updates

- A worker that was force-quit or lost power during an update no longer blocks future in-app updates. If another update really is running, Breezer says so instead of reporting that macOS may have blocked it.
- Breezer removes the downloaded disk image even when macOS refuses to eject it, and cleans up leftovers from earlier failed updates. It keeps only the most recent in-app update backup and leaves manually made backups alone.
- A failed update always reports a final status instead of leaving Settings on "downloading". An update that is still running keeps its lock, even after the Mac sleeps.

## Organato

- An impossible deadline such as month 13 now gets the normal "Use a valid YYYY-MM-DD deadline." message.

- A very large Organato list no longer crashes the local helper. Breezer shows the most relevant items and marks the list as shortened.

## Windows

- The AI sidebar's local helper accepts the window argument Chromium adds when it starts the helper on Windows, so the sidebar can connect. Before publishing, open the sidebar on a packaged Windows build and confirm that a chat starts.

## Developer and site fixes (not user-facing)

- `script/build_and_run.sh` honors `build/local-update-hold.json`. It quits only the build it manages, waits for Breezer to exit before replacing it, and `--verify` checks the expected app path.
- The usage dashboard keeps working when report storage exceeds its listing cap and marks its figures as partial, including when reading reports would exceed its time budget. Retention still removes expired reports at that volume. Configure a Vercel Firewall rate limit for `/api/usage` separately.
- The dashboard caches GitHub download counts and uses `GITHUB_TOKEN` when it is set in Vercel.
- Build tooling:
  - `install_breezer.py` honors the local update hold.
  - Development runs use `build/dev-profile` unless `BREEZER_USE_REAL_PROFILE=1` is set.
  - Builds with uncommitted changes are marked dirty and cannot publish an update manifest.
  - The macOS CI cache covers every overlay input, and Windows rebuilds refuse changed overlays.
  - More test suites run in CI.
- Exit-time cleanup of code-signing clones waits briefly for a busy lock instead of skipping.
