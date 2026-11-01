# Encrypted sync candidate

**PR #6 is a draft. Native compilation and encrypted browser-profile acceptance
have not passed. Do not merge this as a completed feature or describe it as
shipped.** The installed app, personal profile, Keychain and existing browser
build outputs have not been changed.

## Implemented source path

Settings mounts `sync-settings.js` in the shared Sync category. It shows local
workspace queue/errors, exposes recovery for concurrent space/favorite limits,
and opens browser-owned `chrome://breezer-sync/`. Builds without the native API
show that limitation and disable the setup button. A reconciled local workspace
is never labeled as a successful remote upload.

The native page discovers installed providers, configures the selected provider,
waits for asynchronous provider sign-in, lists vaults, creates or joins one,
requires saving a new recovery key, reports native connection/type/error state,
and supports retry/disconnect. The inherited encrypted vault authenticates a
joined vault before installing its configuration. Joining never initializes a
missing vault. Unknown configuration schemas require explicit disconnection
before recovery; setup does not silently overwrite them.

A vault uses a native CSPRNG-generated 32-byte key, shown as a recovery key only
in the browser-owned page. OSCrypt protects the device's saved key and rollback
checkpoint. The setup hold survives closing the page until the configuration
flush completes. The provider receives opaque objects and exact revisions, not
vault keys or credentials. Account-bound provider key wrapping is not used.

`ChromeSyncClient` connects the inherited custom backend to the profile. The
native `PASSWORDS` datatype is enabled for that backend, and native password
controllers retain credential storage and conflict handling. The setup selects
only Preferences and/or Passwords, under a setup hold, before starting normal
sync. `WEBAUTHN_CREDENTIAL` and password-sharing datatypes remain excluded.
Touch ID, Apple Passwords, iCloud Keychain and security-key passkeys are not
claimed to sync through this vault.

Workspace metadata uses a fixed, syncable native preference. Its component-only
API accepts at most 1 MiB and uses provider + vault identity and exact local
preference comparison to reject stale writes. It exposes no arbitrary preference
names, password-store access, protected key material or recovery key. With sync
off, reading state does not construct the Sync service or start provider work.
The component clears its periodic alarm when disconnected, and a payload-free
native event wakes it after setup. Connected profiles refresh every 30 seconds,
including password-only profiles. Native backoff and sticky integrity errors
still apply; an unavailable provider can resume through the normal refresh path.

The local roaming backend remains separate. Before that backend starts, the
new native workspace transport preference is cleared so retained vault metadata
is not fed into its plain folder store. Saved workspace data and merge metadata
remain in extension-local storage. Local roaming cannot be configured here.

## Persistent workspace rules

`workspace-sync-model.js` projects explicit saved fields from `workspace.v1`:

- Space identities, names, colors and order.
- Folders, saved pins and favorites, including stable IDs, titles, URLs and order.
- New-tab placement and close-button behavior.
- The existing bounded appearance fields: layout, sidebar mode, theme/color,
  light/dark/system mode, bookmark-bar mode, width/font size, address-bar and
  progress preferences, and frameless/sidebar/top-bar choices.

It excludes `workspace.members.v1`, live tab/window IDs, browser sessions, folder
expansion, AI conversations, AI memory and provider authentication tokens.
Duplicate URLs retain distinct identities. Per-field logical clocks handle
concurrent changes without depending on wall-clock time. Deleted identities have
permanent tombstones; a stale rename or move cannot resurrect them. Surviving
entries from deleted folders/spaces have a safe remaining/recovery space.
Malformed, incomplete or conflicting identities reject before normalization can
silently discard saved data.

`workspace-sync.js` shares the workspace Web Lock with local sidebar changes.
It durably captures local edits before transport, merges remote records, retries
preference conflicts and only then updates saved UI data. It preserves this
capture across interruption, restart and provider failure. A first joining
profile's untouched defaults do not rename the other profile's spaces or reset
its appearance. A provider change cannot receive a write captured for another
provider, even if both report the same vault UUID. Managed appearance failures
preserve native policy and do not block valid saved spaces.

Concurrent edits can exceed the existing nine-space/twelve-favorite display
limits. Local data and the merged records remain preserved. The Sync card lets
the user explicitly remove a synced space while keeping its pins, or move a
favorite into a space, then retries. Deletion records are not automatically
pruned: doing that safely requires knowing that old offline clients cannot
return. Reaching the total record/byte limit produces an error, not a truncated
workspace or an automatic vault reset.

## Transport and platform limits

The included provider is **a disposable local test transport**, not a hosted
cloud service. `test-provider/server.py` binds only `127.0.0.1`, requires a private
bearer token file, and stores opaque objects/revisions in a private SQLite file.
Its transactions enforce IF_ABSENT/IF_REVISION atomically. Create/list/read/write
are supported. Rename and epoch collection are unsupported, so old ciphertext
is retained. Its object limit is 64 MiB. It uses loopback HTTP, **not TLS**.
Native vault payload encryption in transit still requires native verification.

The provider extension uses the inherited `syncVaultProvider` API and only
`storage` plus that provider permission. Its only network permission is
`http://127.0.0.1:18765/*`. It has no key wrapping or password permission. The
native overlay enables the inherited experimental provider API by default;
actual sync still requires explicit provider/vault setup.

For a private disposable directory, run:

```sh
python3 features/sync/test-provider/server.py --directory /tmp/my-private-sync-test
# Reopen the same private database/token later:
python3 features/sync/test-provider/server.py --directory /tmp/my-private-sync-test --resume
```

Load `test-provider/extension/` as an unpacked extension in each disposable
profile. Its options page accepts the token from the named private token file.
The token is transport authentication, never the vault recovery key. No existing
directory or database is erased by the server. Do not expose it to other hosts.
A real remote provider must separately implement secure authentication, TLS,
revision semantics and the inherited opaque-object contract. No paid service or
production provider has been provisioned, installed or validated here.

Provider-visible metadata includes the vault name/UUID, object identifiers,
revisions and object sizes. Saved workspace and credential contents belong in
native encrypted payloads. Disconnect keeps local saved data and the remote
vault; it does not revoke other connected profiles or erase remote objects.
Changing a vault key in place and remote device revocation are not implemented.
Local workspace/appearance metadata keep their existing plaintext extension and
preference storage. This candidate encrypts the provider vault, rather than
adding local workspace encryption. Native password storage and the saved sync
key/checkpoint retain OS protection, subject to native acceptance below.

## Source preparation and checks

`script/build_and_run.sh` fingerprints/applies sync after the existing overlays.
`script/apply_breezer_sync.py` validates every target before writes and refuses
changed installed feature files, anchor drift and output symlinks. It preserves
compiled output and supports retry after interrupted application. Changed input
fingerprints require a fresh stage or a separately verified migration; never
rewrite markers to make old objects appear current.

```sh
node --test tests/sync.test.mjs tests/sync/setup-browser.test.mjs
node --test tests/ai/settings-redesign-browser.test.mjs tests/ai/workspace-browser.test.mjs
python3 -B script/check_breezer_sync.py
python3 -B script/check_breezer_workspace.py --no-cache
python3 -B script/check_breezer_preparation.py
```

The merge/worker tests run the shipped modules with independent storage/API
fixtures. Provider tests run the actual extension provider JavaScript against
the actual Python HTTP/SQLite server with two independent provider clients.
They cover CAS, stale revisions, binary round trips, authentication, restart,
reconnect, cancellation and private file permissions. Their payloads are random
opaque bytes. They do **not** establish native encryption or password sync.

The setup UI check uses a disposable Chrome context and a message fixture,
including provider progress, recovery confirmation, key clearing, error display,
disconnect cancellation, keyboard focus, light/dark and narrow layout. Screenshots
have `fixture` in their filenames and contain a synthetic key. The settings check
covers the new category with a missing native bridge and preserves peer routes.
Source checks reconstruct pinned Chromium `156.0.8078.47` plus Helium only in
temporary fixtures. None of these checks compiles or launches Breezer.

## Required native acceptance before readiness/merge

The coordinator confirmed that no disposable compiled Breezer browser is
available. The PC build is frozen on older source; Mac output was removed at the
user's request. The allowed standalone slot cannot compile these Chromium
adapters without their generated headers and dependencies. No competing full
build, shared-cache migration, installed-app launch or personal-profile test is
authorized. A combined browser build and a separate GUI/key-protection acceptance
slot are still required.

Use two newly created disposable profiles and the supplied local provider only
when that slot and candidate app exist. Real key-protection/authentication work
must use an isolated OS account if the personal Keychain must remain untouched.

1. Confirm native compilation/linking and provider extension loading. Open Sync
   from the redesigned settings category; verify the browser-owned page and
   disabled/private/managed-profile limits. Cancel asynchronous provider setup
   once; complete it after retry.
2. Create a vault in profile A, save its recovery key and confirm it. Add dummy
   spaces, a folder, distinct saved pins/favorites with identical URLs, appearance
   choices and a dummy credential using the native password manager.
3. In profile B, join with a wrong 32-byte key first. Verify rejection, no
   installed configuration and no remote mutation from B. Retry with the saved
   key; verify actual saved workspace and native credential arrival.
4. Verify credential bytes only through authenticated native password-manager
   operations on that dummy entry. Check add/update/delete propagation and
   native conflict convergence. Never expose plaintext to extension/HTTP pages,
   AI prompts, logs or a CSV. Check component and ordinary-page API denial.
5. Check provider object bytes on disk and on the loopback connection for known
   dummy workspace/credential content and key leakage. They must be native vault
   ciphertext. Verify that the local saved key/checkpoint are OS-protected and
   that wrong-key/corrupted-head/rollback/fork failures stop reconciliation.
   Loopback HTTP is not a TLS acceptance test.
6. Stop/restart the provider, edit both profiles while offline, reconnect, restart
   each profile and verify convergence including deletions and duplicate URLs.
   Check interrupted setup, cancelled authentication, checkpoint failure and
   cancellation while native work is queued. A request already atomically
   committed before cancellation may finish; cancelled queued requests must not
   begin new provider work or install stale checkpoints/diagnostics.
7. Disconnect A and verify its saved spaces/passwords stay local, no new provider
   work is initiated by it, its periodic alarm clears, B remains connected and
   the remote vault is kept. Rejoin and test password-only/workspace-only modes,
   provider switching and explicit overflow recovery. Confirm no live IDs or AI
   state crossed profiles. Test unreadable configuration/key recovery explicitly.

Until this passes, native password-controller behavior, encryption at rest/in
transit, wrong-key rejection, OS key protection and two-browser-profile sync
remain **unverified**, regardless of source or CI results.
