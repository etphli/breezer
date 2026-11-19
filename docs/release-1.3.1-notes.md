# Breezer 1.3.1 draft notes

## Breezer AI

Ask for a theme in plain language, such as “Make my browser dark purple,” then apply the preview when you're ready. Ask about tabs or memory to see measured tab totals for this window and all regular windows, with Breezer memory shown separately from system RAM. Read-only replies keep running when you close the sidebar or switch tabs or windows. Reopen the sidebar in the original window to see the reply.

Before publishing the macOS release, run `node tests/ai/browser-stats-native.mjs <Breezer executable>` on the packaged candidate. In a disposable profile, send natural-language theme and stats requests through the side panel, close and reopen it during a reply, and verify that the reply resumes. Verify that a browser-control turn still stops when you leave its tab.

## New-tab backgrounds

Breezer saves one still of your animated theme's opening frame. The still stays visible while the live artwork loads. Breezer unloads the animation when the tab is hidden and restarts it when you return.

## Organato on Mac

The New Tab card leaves room for your background when the AI sidebar is open in fullscreen. The card stays in place when you open several new tabs quickly.

## Password sign-in

Press Enter in the password field to submit more two-field sign-in forms that have no submit button. This includes forms that group their username and password fields for autofill or mark the username field for passkeys. The sign-in form still runs its normal validation and submit handlers.

Before publishing, verify the signed release build with the [password Enter checks](login-enter.md#native-acceptance-gate). Microsoft's password step still needs its own check.

## Settings address bar

The address bar now shows Breezer Settings while you browse settings. Focus it to reveal the full address.

## Google Docs editing

The editor fixture passes typing, selection, and follow-up editing in Breezer. The expanded fixture from the 1.3.0 work also passed caret and selection checks across separate assistant requests. Signed-in editing and saving remain unverified. Use a disposable document to [check focus, follow-up editing, and saved changes with Codex and Claude](ai-docs-control.md#required-release-acceptance) before marking this limitation resolved.

## Assistant model picker

Click × in the model picker's top-right corner to return to chat. The button is also available while adjusting reasoning or speed.
