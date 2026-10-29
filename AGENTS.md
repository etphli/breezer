# Breezer agent guide

## Update pages and releases

When editing release notes, illustrations, the update-page template, versioning or first-run opening, read [docs/whats-new.md](docs/whats-new.md). It maps the code and tests and links the reusable template. Follow [RELEASE_POLICY.md](RELEASE_POLICY.md) for publication.

Create a new update-page edition for each `1.x.0` release. Append `1.x.1`, `1.x.2` and later patches to that edition; patches keep the same seen-version key and do not automatically open another tab.

## Local installation

The user has opted out of agent-driven local updates. Keep the installed Breezer app unchanged unless the user explicitly asks to update or replace it. Source edits, tests and GitHub publication do not authorize installation. Read `build/local-update-hold.json` when present before any install workflow. Preserve the browser profile, passwords and required compiled caches.
