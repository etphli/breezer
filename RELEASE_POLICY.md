# Breezer releases

Ship a feature release after roughly four or five finished, user-visible features. Ship a patch release sooner when something is broken; do not wait for a feature quota to fix a regression.

## Before publishing

- Keep the change focused. Finish the relevant tests, native build and actual-app checks.
- Verify the installed replacement and preserve the user's profile, passwords and tabs.
- Update `features/ai/extension/release-info.js`, the extension manifest version and the bundled What's new page for the release. Describe only shipped behaviour and state known limitations.
- The What's new page uses a light cream design and opens once per minor release (for example 1.1.0 or 1.2.0) in a regular window after updating. Patch releases such as 1.1.1 append notes to the existing 1.1 page and do not reopen it automatically. Start a new page only when the 1.x.0 version changes. It must not reopen on every launch or open in private browsing.
- Publish clean source with green CI, a matching Apple Silicon DMG, SHA-256 checksum, build information and `breezer-update.json` to the GitHub release. Keep historical releases and Git history.
- After the new installed app and release artifact are verified, remove obsolete local Breezer installers and app copies. Preserve the latest app/DMG, user data, source, toolchains, prepared source and every required build cache. Never delete unrelated downloads.

Do not describe source tests or simulated browser input as physical native mouse verification. Do not claim Touch ID, live integrations, update handoff or performance improvements without the corresponding evidence.
