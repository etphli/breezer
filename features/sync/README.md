# Encrypted sync implementation status

This is unfinished source work. Nothing in this directory is installed, applied
by preparation, enabled, or connected to the shipped settings page. Do not
advertise spaces or password sync as shipped from these files.

## What is implemented

`features/ai/extension/workspace-sync-model.js` defines the persistent workspace
merge model. It projects an explicit allowlist from `workspace.v1`, uses saved
entity IDs rather than URLs, merges changes to individual fields with logical
clocks and a stable device tie-breaker, and retains permanent deletion records.
Moving or renaming an offline deleted item cannot resurrect it. Deleted folders
and spaces leave surviving entries in an existing or deterministic recovery
space. Folder expansion stays local. Malformed data, clock exhaustion, and
capacity overflow reject without replacing a client's local workspace.

The model includes spaces, folders, pins, favorites, the two workspace behavior
preferences, and the existing bounded appearance fields. It does not include
`workspace.members.v1`, tab/window IDs, live pages, browser sessions, AI prompts,
AI memory, provider tokens, passwords, or vault keys. Nothing calls the module
from the shipped extension yet.

`native/chrome/browser/sync/breezer_sync/` contains an **uncompiled draft** of
an adapter for the inherited Helium provider broker and vault backend. It must
not be wired into preparation until native compilation and lifecycle review.
It uses the existing `SyncVaultStore`, `SyncVaultCryptographer`,
`LoopbackServerStateCodec`, `SyncVaultBackend`, protected configuration repository
and OSCrypt encryptor. It does not implement new encryption or serialize
passwords in JavaScript. The transport checks the selected provider identity,
forwards opaque bytes and exact CAS revisions, and supports engine shutdown
while UI/provider replies are pending. Epoch collection is deliberately
unsupported in the draft, retaining ciphertext rather than risking deletion.

## Confirmed inherited gaps

The imported patches implement vault encryption, journal verification, rollback
checkpoints, CAS conflict retries, a provider extension broker, a persisted
configuration repository, and generic `CustomSyncBackend` hooks.

They do **not** implement ChromeSyncClient overrides for those hooks or a
concrete extension-provider `SyncVaultTransport`. The
`settings/sync-setup-contract.patch` adds Mojo declarations only. There is no
native setup handler or setup UI implementing that interface in this import.
`CustomSyncSupportedTypes()` excludes `PASSWORDS`. Restoring local password
saving does not enable password sync.

Those findings come from the actual imported patches under
`upstream/helium-macos/helium-chromium/patches/helium/core/sync/` and
`patches/helium/settings/sync-setup-contract.patch`, rather than an assumption
that the sync engine is absent.

## Work required before usable sync

1. Compile and review the native draft; complete diagnostics, provider changes,
   cancellation, shutdown and durable checkpoint failure handling. Validate
   protection availability and recovery after OS key access fails.
2. Implement browser-owned setup, provider discovery/configuration, create/join,
   recovery-key confirmation, wrong-key rejection, cancellation, retry and
   disconnect. Recovery keys must never enter the AI extension or its storage.
3. Wire the adapter into ChromeSyncClient and the profile service dependency
   graph. Enable native `PASSWORDS` only after its controllers are confirmed to
   work with the custom encrypted backend. Keep `WEBAUTHN_CREDENTIAL` excluded.
4. Add bounded native workspace/status APIs and durable workspace reconciliation
   using the merge model. Integrate reconnect/restart, opt-in, provider switching
   and disconnect; keep a recoverable local copy and deletion records. Provide
   explicit recovery for concurrent capacity overflow and tombstone limits.
5. Add an actual supported provider or realistic local CAS test provider using
   the existing provider contract. Do not substitute a local export, invented
   crypto or a success fixture for this transport.
6. Add feature-owned `sync-settings.js` to the settings owner's `FEATURE_MOUNTS`
   with `{ container: 'sync-settings', load: () => import('./sync-settings.js')
   .then(m => m.mountSyncSettings) }`. Return a dispose handle. The settings peer
   owns the container, category, search and shared layout. No mount exists yet.
7. Verify two disposable native profiles through that transport, including
   encryption at rest/in transit, wrong keys, concurrent updates/deletions,
   duplicate URLs, restart/reconnect, password add/update/delete, recovery,
   disabled/disconnected behavior and no extension credential exposure.

Platform passkeys remain owned by the passkeys thread. This work makes no claim
that Touch ID, Apple Passwords, iCloud Keychain or WebAuthn private keys travel
through Breezer's vault.

## Verification so far

```sh
node --test tests/sync.test.mjs
node --test tests/ai/workspace-store.test.mjs tests/ai/workspace-static.test.mjs
```

The first command runs nine merge-model tests. They exercise the real shipped
module as two in-memory clients, with serialized restart state. These are pure
model tests, **not** encrypted transport, native compilation, browser-profile,
password-controller, Keychain or cloud-sync acceptance.

No disposable compiled Breezer browser is available. The release coordinator
confirmed that the current PC build predates these changes and that the Mac
output was deleted at the user's request. The installed app and personal profile
are off limits. No build outputs, prepared source or shared caches were changed.
The native draft has not been built or run. A complete browser build and the
acceptance above remain required before this feature can be merged as usable
sync or included in 1.2.0 release claims.

The imported source fixture used for API inspection was reconstructed only in
`/tmp` from pinned Chromium `156.0.8078.47` and checked-in Helium patches.
