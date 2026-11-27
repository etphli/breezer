# Breezer 1.3.7 draft notes

These notes collect fixes for the next patch after 1.3.6. Nothing here is published yet. When the 1.3.7 release is prepared, append an illustrated `patch-137` section to `features/ai/extension/whats-new.html` after the 1.3.6 section, following [whats-new.md](whats-new.md). Patches keep the 1.3.0 seen-version key and do not open another tab.

## Breezer AI

- When the model sends a browser action with bad arguments, such as an address without `https://`, Claude now sees the error and can try again. The chat no longer ends with "Invalid URL".
- A browser action that finishes after the helper's time limit no longer stops the chat on screen while it keeps running in the background. Your next message no longer fails with "Another chat is already running".
- If the local helper fails to load the chat engine, the chat shows an error instead of spinning. The next message tries to load it again.
- Scrolling now covers the full distance the assistant asks for.

## Updates

- A worker that was force-quit or lost power during an update no longer blocks future in-app updates. If another update really is running, Breezer says so instead of reporting that macOS may have blocked it.
- Breezer removes the downloaded disk image even when macOS refuses to eject it. It keeps only the most recent app backup instead of adding a full copy for each update.

## Organato

- An impossible deadline such as month 13 now gets the normal "Use a valid YYYY-MM-DD deadline." message.

## Windows

- The AI sidebar's local helper accepts the window argument Chromium adds when it starts the helper on Windows, so the sidebar can connect. Before publishing, open the sidebar on a packaged Windows build and confirm that a chat starts.

## Developer and site fixes (not user-facing)

- `script/build_and_run.sh` honors `build/local-update-hold.json`. It quits only the build it manages, waits for Breezer to exit before replacing it, and `--verify` checks the expected app path.
- The usage dashboard keeps working when report storage exceeds its listing cap and marks its figures as partial. Retention still removes expired reports at that volume. `/api/usage` rejects bodies over 4 KB before parsing. Configure a Vercel Firewall rate limit for `/api/usage` separately.
