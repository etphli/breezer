# Breezer 1.3.1 draft notes

## Password sign-in

Press Enter in the password field to submit more two-field sign-in forms that have no submit button. This includes forms that group their username and password fields for autofill or mark the username field for passkeys. The sign-in form still runs its normal validation and submit handlers.

Before publishing, verify the signed release build with the [password Enter checks](login-enter.md#native-acceptance-gate). Microsoft's password step still needs its own check.

## Google Docs editing

The editor fixture passes typing, selection, and follow-up editing in Breezer. The expanded fixture from the 1.3.0 work also passed caret and selection checks across separate assistant requests. Signed-in editing and saving remain unverified. Use a disposable document to [check focus, follow-up editing, and saved changes with Codex and Claude](ai-docs-control.md#required-release-acceptance) before marking this limitation resolved.
