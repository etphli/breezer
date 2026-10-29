# In-app updates and macOS trust

Breezer checks stable GitHub releases, requires a descendant source commit, validates the release manifest and download digest, and verifies the downloaded app identity, architecture and code signature before replacement. These checks are in `features/ai/host/updater.mjs` and `update-worker.mjs`.

## Worker handoff

The native host starts its existing `process.execPath` with a standalone worker script and request file in a private sibling staging directory. It copies no executable. The worker acknowledges startup through Node IPC after acquiring its update lock and writing download status. The controller reports progress only after that acknowledgement. An early exit or a missing acknowledgement produces an error and removes the failed staging directory.

The worker and request are outside the app so they survive replacement. A running executable remains available while its original path is renamed or removed; the updater regression suite exercises that lifetime with a disposable runtime. The test uses the repository's ignored build directory because macOS may reject executable copies in its per-user temporary directory. This is a lifecycle test, not Gatekeeper acceptance.

A previous app retained during replacement has a concrete rollback purpose. Remove it after the updated app is verified; do not accumulate obsolete copies. The browser profile and passwords live outside the app and are preserved.

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
```

These cover release validation, rollback, reuse of the running runtime, private request permissions, startup acknowledgement, early exit, startup timeout and executable lifetime across replacement. Test the signed distribution and actual published upgrade separately; source tests are not proof of Gatekeeper acceptance.
