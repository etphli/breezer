# Native passkeys on macOS

Breezer keeps WebAuthn in Chromium. Websites request creation or sign-in through
`navigator.credentials`; the native browser dialog selects an authenticator and
requests user approval. Eligible username fields with `autocomplete="username
webauthn"` can use Chromium's conditional passkey suggestions. Websites must
support these flows. Password saving, CSV import and password autofill keep their
existing native paths.

Settings > Passwords includes **Manage local passkeys**, opening
`chrome://settings/passkeys`. This restores Chromium's existing Mac profile
passkey list, username editing and confirmed deletion. It does not collect
credentials in the extension. Opening the page is not evidence that a platform
authenticator is available.

## Availability and ownership

The current Breezer build has an empty Apple team identifier and omits branded
entitlements. **Creating or using local Mac/Touch ID passkeys and direct Apple
Passwords integration remain unavailable in that build.** Removing Helium's
forced-off preference cannot grant Apple entitlements. A signed, provisioned
combined build and hardware acceptance are still required before advertising
browser-managed Mac passkeys as working.

| Authenticator | Storage and management | Current boundary |
| --- | --- | --- |
| Mac profile authenticator | Secure Enclave keys in Keychain, non-synchronizable. Metadata is bound to the Breezer profile secret and its configured team/bundle access group. Manage in `chrome://settings/passkeys`. | Requires a valid matching Keychain access-group entitlement, supported hardware and macOS device authentication. Unavailable with current signing. |
| Apple Passwords / iCloud Keychain | Apple controls storage, enrollment, device approval and sync. Manage in Apple Passwords. | Chromium checks the public-key-credential entitlement and OS availability. Unavailable with current signing. No new iCloud enrollment or backup is promised. |
| Security key | Authenticator holds the credential. Manage with the key's supported native tooling, including Chromium's existing `chrome://settings/securityKeys` where available. | Website, key, transport and user-verification support determine available choices. Physical hardware acceptance remains pending. |
| Another device / phone | Credential stays with that provider. Native cross-device flow requests device approval. | Requires compatible devices, Bluetooth/proximity and connectivity. Phone/QR acceptance remains pending. |

Passkeys are excluded from CSV password import and Breezer sync. Sync's
`PASSWORDS` datatype does not enable `WEBAUTHN_CREDENTIAL`. Local Mac passkeys
are not portable profile files or iCloud backups. Keep the native profile and
Keychain identities stable; changing their team, bundle, or metadata secret can
make existing credentials inaccessible. This change leaves those identities
untouched.

Breezer AI gains no credential API, export path, authentication bypass or secret
input capability. The extension opens fixed native routes only.

## Source audit

The pin is Chromium `156.0.8078.47` plus the checked-in Helium series. Source
hashes are in `features/passwords/native-ui/upstream.json`.

- Helium inserts `DisabledPasswordManagerPolicyHandler`, forcing both password
  saving and `kCredentialsEnablePasskeys` off. The previous Breezer password
  overlay retained a `DisabledPasskeysPolicyHandler`. The updated overlay
  removes the fabricated policy entirely. Native preferences and real enterprise
  policy still apply; existing user preferences are not reset.
- `kCredentialsEnablePasskeys` gates Google Password Manager enclave creation
  in `ChromeAuthenticatorRequestDelegate::ConfigureDiscoveries`. It does not
  globally enable WebAuthn, grant Apple permissions, or unlock local storage.
  Breezer does not add a Google account provider.
- Helium removes the `/passkeys` route and disables the saved-info section.
  Breezer restores only a Mac passkeys section under the native advanced
  routes. The existing lazy loader supplies `settings-passkeys-page`. It is a
  direct native view, so Settings does not mistake it for a search plugin.
  The page stays hidden during native global search; use the Passwords category
  in Breezer Settings search or the native page's own credential filter.
- `PasskeysHandler` already uses `LocalCredentialManagement::Create` with the
  current profile. The Mac implementation enumerates, edits and deletes through
  `TouchIdCredentialStore`, using the same profile config as creation/sign-in.
  The page retains native filtering, deletion confirmation and error handling.
- `TouchIdContext::TouchIdAvailableImpl` checks the exact configured entitlement,
  device authentication and Secure Enclave. `credential_store.mm` uses
  `kSecAttrTokenIDSecureEnclave` and `kSecAttrSynchronizable = NO`.
- The iCloud implementation checks
  `com.apple.developer.web-browser.public-key-credential`. All OS availability
  and entitlement checks stay unchanged. Chromium's current pin also excludes
  its iCloud path from PWA windows.
- `AuthenticatorCommonImpl` retains ancestor-origin and relying-party validation,
  cancellation and the native request flow. No WebAuthn implementation, key
  material, native credential handler, or authentication check is replaced.

Primary sources, inspected at the pinned version:

- [Chromium's macOS profile config](https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/chrome/browser/webauthn/chrome_web_authentication_delegate.cc)
- [Chromium's Touch ID availability checks](https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/device/fido/mac/touch_id_context.mm)
- [Chromium's Mac credential store](https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/device/fido/mac/credential_store.mm)
- [Chromium's Apple provider](https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/device/fido/mac/icloud_keychain_sys.mm)
- [Chromium's local credential management](https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/chrome/browser/webauthn/local_credential_management_mac.cc)
- [Chromium's WebAuthn validation](https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/content/browser/webauth/authenticator_common_impl.cc)

## Reproducible checks

```sh
node --test tests/passwords.test.mjs
python3 script/check_breezer_passwords.py
npm ci --prefix tests/ai
# Install into disposable workspace output, not a shared browser/cache.
PLAYWRIGHT_BROWSERS_PATH="$PWD/build/passkeys/browsers" \
  tests/ai/node_modules/.bin/playwright install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/build/passkeys/browsers" \
  node tests/passkeys/component.mjs
PLAYWRIGHT_BROWSERS_PATH="$PWD/build/passkeys/browsers" \
  node tests/passkeys/virtual.mjs
```

The source checker reconstructs only named pinned files in temporary copies. It
runs 8 password, 6 proactive-password and 5 passkey tests with no skipped source
checks, verifies apply/check/retry/drift behavior and preserves all supplied
source bytes. `--offline` reuses this worktree's downloaded source fixture.
The new passkey suite fails against the old overlay for its forced policy and
missing route. Native handler/storage hashes must remain unchanged.

The component test runs the shipped module with a dummy tabs API at 1280 px and
360 px, in light and dark themes. It checks the exact passkey route, truthful
availability/storage copy, pending actions, errors, retry, keyboard guide focus
and disposal, and saves screenshots. This is UI routing evidence only.

The WebAuthn test uses a disposable Chrome for Testing `156.0.8078.4` context and
CDP virtual authenticator. It creates a resident credential, verifies an actual
assertion signature using the registered public key, checks challenge/origin/RP
hash and user-presence/verification flags, rejects wrong RP and origin, cancels
creation/sign-in/conditional autofill, and removes the virtual credential before
verifying that it can no longer sign in. It never requests `getCredentials`,
which would export virtual private keys. This proves WebAuthn fixture/protocol
behavior, not the Breezer overlay, biometric authentication or native storage.

## Combined-build acceptance still required

No rebuilt disposable Breezer was available. The release coordinator's current
PC build predates this branch; no shared prepared source, compiled output,
installed app, personal profile or Keychain was used. No standalone Foundation
compile could validate these changes, so none is presented as browser proof.

On a rebuilt test app, use only a disposable profile and dummy accounts:

1. Open Settings > Passwords > Manage local passkeys. Confirm the native page
   mounts, reloads at `/passkeys`, filters and reports unsupported storage
   accurately. Test native Settings search and navigation back as well.
2. Inspect signing entitlements before testing local enrollment. Without the
   matching group and approved provisioning, expect platform unavailability.
   Do not bypass the check or substitute another browser's identity.
3. With valid signing/hardware, use the committed `tests/passkeys/webauthn.html`
   through a loopback server. Create and sign in, approve OS authentication,
   cancel once, then retry. Verify the entry in the native local passkey page,
   edit its dummy username, restart the disposable profile, then delete with
   confirmation. Confirm sign-in no longer offers it. Never export a key.
4. Test native conditional suggestions by focusing the dummy username field
   after Offer passkey autofill. Choose a dummy passkey; cancel and retry too.
   Virtual cancellation alone does not prove native selection/autofill.
5. Test a physical key, wrong RP/origin, and a phone/QR flow separately. Manage
   their dummy credentials with their actual provider. Test Apple Passwords
   only with appropriate signing/account approval; do not claim cloud sync from
   a local key.
6. Repeat [password runtime acceptance](../features/passwords/README.md) and
   [password import acceptance](passwords.md), including CSV, save/update cues,
   autofill, authentication cancellation and deletion.

A passing virtual test is not a reason to check off these native acceptance
steps or announce complete browser-managed passkey support.
