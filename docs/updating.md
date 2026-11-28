# In-app updates and macOS trust

## Temporary signature clones

The native signature-clone overlay in
[`features/storage/code-sign-clones`](../features/storage/code-sign-clones/README.md)
uses process-held leases to retain active app snapshots through shutdown and
recover abandoned snapshots after forced exits. Cleanup is bounded, runs after
clone readiness, and never uses absence from `lsof` as evidence of abandonment.
Older clones without a recognized ownership record are retained. This preserves
the APFS clone, hard-linked executable and parent-exit handoff used for update
signature validation. Machine-specific recovery scripts are not shipped.

Breezer checks stable GitHub releases, requires a descendant source commit, validates the release manifest and download digest, and verifies the downloaded app identity, architecture and code signature before replacement. These checks are in `features/ai/host/updater.mjs` and `update-worker.mjs`.

## Settings helper lifetime

The extension starts the updater host on the first request. After a reply, it
disconnects after 250 ms only when there are no pending requests, no checked
release and no active installation. An available release retains its exact host
and checked candidate. A successful worker acknowledgement retains the connection
through status polling until `installed` or `failed`. A failed check does not
discard a previously checked candidate that the host still owns.

Idle Settings clients reconnect on their next action after worker retirement.
An unexpected disconnect invalidates the Install control and requires another
check. Installation requests are never automatically replayed. These lifetime
rules do not change release validation, worker handoff or replacement checks.

## Worker handoff

The native host starts its existing `process.execPath` with a standalone worker script and request file in a private sibling staging directory. It copies no executable. The worker acknowledges startup through Node IPC after acquiring its update lock and writing download status. The controller reports progress only after that acknowledgement. An early exit or a missing acknowledgement produces an error and removes the failed staging directory. A worker that fails before acknowledgement, for example on a lock it cannot read or an invalid request, sends `update-worker-blocked` with the real error so Settings does not blame macOS.

The lock records the worker PID and start time. A later worker can reclaim it when the PID is gone, or when that PID belongs to a process that started after the lock was taken (a reused PID). A live owner is kept regardless of age, because sleep advances the wall clock during a long download. The one-hour age limit applies only when the owner's start time cannot be checked. A live lock reports that another update is already running and preserves that update's progress.

Each worker writes only its own status file beside the app, `.Breezer-update-status-<owner id>.json`, named after its lock owner record, so a worker that has lost its lock cannot overwrite a successor's progress. Progress writes abort the update once the lock is lost; terminal `installed` and `failed` phases are written regardless, so Settings never keeps polling a stale `downloading` phase. The host's `update-status` reply (`readUpdateStatus` in `updater.mjs`) shows the current lock owner's record; with no lock, or before the owner has written, it shows the worker that most recently acquired the lock, then the single `.Breezer-update-status.json` written by earlier releases. A new owner removes superseded status files. Once the new app has replaced the old one and launched, the worker reports `installed` even if it then loses the lock; backup pruning is best effort and skipped without the lock. Development hosts outside Breezer.app return empty update status.

The worker and request are outside the app so they survive replacement. A running executable remains available while its original path is renamed or removed; the updater regression suite exercises that lifetime with a disposable runtime. The test uses the repository's ignored build directory because macOS may reject executable copies in its per-user temporary directory. This is a lifecycle test, not Gatekeeper acceptance.

If normal DMG detach fails, the worker retries with forced detach and removes staging. If the volume remains mounted, the worker removes the downloaded DMG and leaves the mount point alone. While holding the lock, the next worker force-detaches and removes earlier `.breezer-update-*` staging directories beside the app that are at least ten minutes old. It skips its own directory, symbolic links and any volume that stays mounted. A successful verified replacement keeps the previous app for rollback and prunes older `Breezer-update-*` backups. Manual `Breezer-YYYYMMDD-HHMMSS.app` backups made by `script/build_and_run.sh` are kept. The browser profile and passwords live outside the app and are preserved.

## Why the earlier helper was blocked

The old host copied Node into each update staging directory. In the reported incident those new copies had `com.apple.quarantine`, despite matching the bundled runtime byte for byte and having valid ad-hoc signatures. Gatekeeper rejected the copied executable before the worker could start. A successful process-spawn event was incorrectly reported as an update in progress.

Reusing the existing runtime removes that unnecessary executable copy. Startup acknowledgement detects refusal or failure before the worker begins. This does not make an ad-hoc app notarized or promise that macOS will accept every future downloaded build.

## Distribution trust

Default Gatekeeper acceptance requires an appropriate Developer ID signature and Apple notarization. The release build currently uses local ad-hoc signing; no valid Developer ID identity is available on this machine. Release metadata must disclose that limitation. Do not disable Gatekeeper globally or remove quarantine automatically from downloaded software as an update mechanism.

The installed older updater cannot receive a source fix without an update. A one-time manual installation or a separately authorized recovery may be required to bootstrap the corrected updater. Source publication is not permission to replace the user's installed app.

Apple reference: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution

## Checks

```sh
node --test tests/ai/updater.test.mjs
node --test tests/ai/update-lifetime.test.mjs
node --test tests/ai/update-worker-recovery.test.mjs tests/ai/update-worker-followups.test.mjs
```

These cover release validation, rollback, reuse of the running runtime, private request permissions, startup acknowledgement, early exit, startup timeout and executable lifetime across replacement. Test the signed distribution and actual published upgrade separately; source tests are not proof of Gatekeeper acceptance.
The lifetime tests also cover pending calls, checked candidates, active installs,
terminal status, idle release, page ownership and reconnect without install replay.
