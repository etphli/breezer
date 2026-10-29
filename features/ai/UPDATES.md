# In-app updates

Settings checks the latest stable release from `etphli/breezer` when opened.
The user must click **Update and restart** to download and install. Prereleases
are excluded. There is no background browsing telemetry and no GitHub token.

Each eligible release needs its arm64 DMG and a `breezer-update.json` asset:

```
python3 script/package_breezer_dmg.py /path/Breezer.app /release/Breezer-arm64.dmg --update-manifest /release/breezer-update.json
```

Upload both files plus the generated `.sha256` to the same GitHub release.
The manifest contains the bundled source commit, DMG filename and SHA-256.
The GitHub comparison API must confirm that the release commit descends from
the installed commit. Missing metadata, older releases and diverged histories
do not offer installation. Build identity is bundled before code signing.

Only `~/Applications/Breezer.app` and `/Applications/Breezer.app` are supported.
The user must have write access; the updater never requests root access.
It uses the bundled Node runtime, copied outside the app while updating.
Downloads are size-limited and checksum-checked. The mounted read-only app is
checked for bundle identity, arm64 support, source commit, escaping symlinks,
and a valid deep code signature before replacing the running app.

The previous app stays in `.Breezer-backups`. Replacement errors restore it.
The browser profile and credentials are never edited. Update status is saved
beside the app in `.Breezer-update-status.json`. A directory lock prevents two
updaters replacing the app concurrently. An interrupted worker may leave that
lock and its staging directory; do not remove these while an updater is running.

Trust comes from HTTPS and the fixed GitHub repository/release assets. The
checksum does not independently authenticate a compromised GitHub account.
Existing local Breezer builds use ad-hoc signatures; a valid signature alone is
not a Developer ID or notarization claim.

Tests cover release selection, rejected metadata, settings messages and
transactional rollback. Live replacement from a published update requires a
new compatible release; do not describe mocked tests as a production upgrade.
