# Final 1.2.0 release checks

PR #15 merged at `6bbe560a9bdb4fa0f91b5aad7ed975ee4f862fb5` after all three checks
passed. The final PC incremental build finished at 304/304 actions with no failed
actions. The source migration retained compiled progress, exact PGO profile,
hardening and feature flags, four normal jobs and one link slot.

The copied archive and all three native binary hashes matched. The final app
reports `Breezer 1.2.0 (Chromium 156.0.8078.47)`. All 50 native PAK extension
resources match the merged source byte for byte, including the separate article.
The packaged host identifies the same merged commit, and its Node runtime matches
the checksum pin. The app and mounted read-only DMG passed deep strict signature,
arm64, version, native/runtime hash and Applications-link checks.

The actual compiled app loaded the update page, separate article and settings in
a disposable headless profile. Its generated research APIs are registered. The
non-baseline Enter runner passed all 32 scenarios after isolating each case in a
fresh page. Its former shared-page reset aborted after the submit-button case
in both the old and repaired compiled candidates. No assertions were removed.
`login-enter.png` shows the repaired compiled app with dummy data.

These runs use a mock Keychain. They do not verify real credential storage,
encrypted two-profile/password sync, native password-picker selection, physical
macOS shortcuts, IME, Apple entitlements or authenticated Google Docs. The four
Blink unit tests remain uncompiled and unrun. See [login-enter.md](../../login-enter.md)
and the release inventory for the remaining acceptance limits.

`download.png` is a rendered website source fixture showing the 1.2.0 version
and exact asset link. The website's nine checks pass. Merge the website link
change only after the release assets are public and hash-verified.

The release assets include the DMG, checksum, updater manifest and build
information. Build information preserves the exact hashes, checks and limits.
No installed app, personal profile, stopped Mac build or compiled cache was
replaced or removed. Ubuntu was stopped after the completed artifact was copied.
