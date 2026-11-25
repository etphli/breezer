# Password import and management

Settings includes password management and a CSV import guide for Chrome, Edge and other password managers that export compatible files. The build applies a native overlay to restore password saving and its entry points.

Import makes a one-time copy in the Breezer profile. Breezer uses the platform's native password store and an independent Keychain identity on macOS. The extension only opens fixed browser routes through `chrome.tabs.create`. Chromium handles the files and saved entries.

## User flow

The component has password actions and a separate passkey section:

- Check passkey availability opens Chromium's passkey settings. On macOS, the section explains the current signing limits and external-provider ownership.
- Open password manager opens Breezer's native saved-password list.
- Password settings opens native controls for saving, automatic sign-in, and supported authentication before filling.
- Import passwords expands the guide. Import password CSV opens the native importer and file picker.

Export saved passwords as CSV, then select the file in Breezer. Review conflicts or errors in the native importer. After verifying the imported entries, delete the readable export and remove it from the Trash or Recycle Bin. Password CSVs do not transfer passkeys. [Chrome export instructions](https://support.google.com/chrome/answer/13068232?hl=en), [Edge export instructions](https://support.microsoft.com/en-us/edge/export-passwords-in-microsoft-edge).

On Windows, choose **Import browser data** in Browser tools to import the categories offered for a detected browser profile. **Bookmarks HTML File** accepts an HTML export when the source profile is unavailable. A standard 64-bit Firefox installation in Program Files supports **Saved passwords**. Select it explicitly and close Firefox if prompted. Use Firefox's authenticated CSV export if **Saved passwords** is unavailable or the profile is protected by a Primary Password. [Firefox export instructions](https://support.mozilla.org/en-US/kb/export-login-data-firefox).

## Settings agent integration

Mount into an empty element within the existing settings column. The component supplies its own `section`, heading, guide, status, and error elements. It reuses the existing `settings-section`, `section-note`, `text-button`, and `field-error` classes. It uses the containing document's theme and needs no CSS or permission additions.

```js
import { mountPasswords } from './passwords.js';

const passwords = mountPasswords({
	container: document.getElementById('password-settings'),
	api: chrome,
	onOpened(destination) {
		// Optional navigation notification only. Never an import completion event.
		// destination is 'manager', 'settings', 'import', or 'passkeys'.
	},
});

// An onboarding/import shortcut may expand and focus the guide.
passwords.showImport();

// Call when the host removes or remounts this settings view.
passwords.dispose();
```

`mountPasswords` is synchronous. `api` defaults to `globalThis.chrome`; `onOpened` defaults to a no-op and should not throw. Buttons are disabled while opening a native tab. Failed opens show a fixed fallback address without displaying raw error text. `dispose` removes listeners and suppresses post-await notifications. A missing tabs API disables native actions and explains that Breezer is needed.

`createPasswordActions({api}).open(destination)` exposes the same fixed routes without rendering. It rejects unknown destinations. The `browserImport` route opens Chromium's native browser chooser.

The main Settings page mounts this component in its Passwords section. The first-run card calls `showImport()` for **Show password steps** and opens `browserImport` for **Import browser data**.

## Native preparation

Apply the separate overlay after Helium patches and Breezer branding, before GN/resource generation:

```sh
python3 features/passwords/native-ui/apply.py "$PREPARED_SOURCE"
python3 features/passwords/native-ui/apply.py "$PREPARED_SOURCE" --check
python3 features/passwords/native-ui/apply.py --fingerprint
```

`script/build_and_run.sh` checks the separate `src/.breezer-passwords-prepared` fingerprint before refreshing resources. A matching marker still runs `--check`; a different marker refuses before changing source. The hosted cache fingerprint includes every native password input. Existing compiled output is retained on first application.

The applicator stages all fourteen files before writing. It accepts either the pinned Helium state or its already-applied state, refuses missing, ambiguous, drifted, or symlinked targets, and uses file-level atomic replacement. A retry after a partial application converges. `--check` never writes. Its implementation follows the existing omnibox applicator's staging rules; its wider patch context also prevents duplicate insertion of the restored native action. See [native password behavior and verification](../features/passwords/README.md) for save/update cues and explicit fill selection.

The patch restores only password functionality removed by Helium:

- Restores the native password-saving default to on, preserving explicit saved choices. Automatic sign-in stays off.
- Removes the forced-false `kCredentialsEnableService` assignment. Chromium's password-saving preference and enterprise policy apply normally. The fabricated passkey policy is also removed; native passkey availability still depends on platform signing and authentication. See [passkey availability and verification](passkeys.md).
- Restores Chromium's native password action, so the password page-action controller and save/update bubble have their normal action item. It also restores the password icon in app windows.
- Restores the native manage-passwords footer in autofill suggestions.

The shared password overlay uses Chromium's native password store, CSV importer and device authentication. The Windows-only [import patch](../features/passwords/native-ui/windows-import.patch) uses the registered Firefox NSS runtime in native Program Files. It opens the profile read-only with external NSS modules disabled and leaves **Saved passwords** unchecked each time the import dialog opens. The inherited Helium startup patch disables automatic first-run import.

## Pinned implementation evidence

The inspected source is Chromium `156.0.8078.47` with Helium `f29a25968e483f8bb85e47829ccd487bbe229199`, macOS overlay `9aa975a56de8c2376d7c22f71da564b9426cda5f`, and Breezer branding. `features/passwords/native-ui/upstream.json` records source-file hashes. These are hashes of source code, never user profile data.

- `chrome/browser/ui/webui/chrome_web_ui_configs.cc` registers `PasswordManagerUIConfig`; `chrome/chrome_paks.gni` retains the password-manager resources.
- `chrome/browser/resources/password_manager/router.ts` defines `/passwords`, `/settings`, and `UrlParam.START_IMPORT = 'import'`. `settings_section.ts` calls `launchImport()` when `?import=true`. The literal query is `import`, not `startImport`.
- `chrome/browser/resources/settings/route.ts` defines `/importData`. The native handler intersects the selected categories with the source profile's capabilities.
- `chrome/utility/importer/chrome_importer.cc` implements history and bookmarks for detected Chromium-based browsers. On Windows, the native Firefox importer uses the existing NSS authentication and a runtime path resolved from the machine installation.
- `passwords_importer.ts` defaults to `PasswordStoreSet.DEVICE` for non-account users and preserves the native parser, conflict selection, errors, and optional source-file deletion. Breezer's non-Google profile does not activate Google account password storage. Helium's `password_manager_features_util.cc` requires active upload to Google before enabling that store. If Main later adds account storage or password sync providers, re-audit these local-only claims before shipping them.
- `ProfilePasswordStoreFactory` creates the profile store with `profile->GetPath()` and `g_browser_process->os_crypt_async()`. `LoginDatabase` encrypts password values through that native encryptor and fails writes on encryption failure. This does not claim that all password metadata is encrypted.
- Branding assigns `Breezer Storage Key` / `Breezer` in `keychain_password_mac.mm`; it does not reuse Chrome's Keychain item. This identity difference does not provide Chrome sync.
- `PasswordsPrivateDelegateImpl` retains native `RequestCredentialsDetails`, `RequestPlaintextPassword`, `ChangeCredential`, `RemoveCredential`, and import paths. Viewing details/plaintext uses `AuthenticateUser`, which invokes the native device authenticator on macOS. Native authentication caching and operation-specific behavior remain unchanged. The UI does not promise a fresh prompt on every edit or deletion.

The extension has no `passwordsPrivate` access, CSV parser, extension-storage password vault, custom crypto, or credential logging.

## Verification

Run the action tests and source checks without installing dependencies or building:

```sh
node --test tests/passwords.test.mjs
python3 tests/passwords_native_test.py
BREEZER_PASSWORD_SOURCE=/path/to/prepared/chromium/src python3 tests/passwords_native_test.py
node tests/passwords/installed.mjs /absolute/path/Breezer.app
```

Without `BREEZER_PASSWORD_SOURCE`, the six native-source tests explicitly skip. With it, the checks read only named source files. They apply the overlay to temporary copies, verify idempotence, interrupted retries, drift/symlink refusal, native passkey policy and platform boundaries, restored native entry points, routes, profile encryption wiring, native authentication, and unsupported direct import. They also compare the inspected source hashes. They never open a profile or password database.

The installed-app test uses a temporary profile with the native Mac password backend. It checks that saving is enabled, then adds one dummy local credential, changes its username, restarts the profile to check persistence, and deletes it. It never requests plaintext. CSV import, autofill selection, and OS authentication need the separate UI acceptance below. The pre-fix installed app fails this test because saving is enforced off.

For a real DOM check, from the repo root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/tests/passwords/component.html`. Its self-running dummy tabs API checks guide expansion/focus, exact URLs, pending/duplicate clicks, failure/retry, unavailable API, callbacks, and disposal including completion after disposal. `document.documentElement.dataset.result` must equal `pass`. This exercises the shipped component, not native import.

Verified on this branch:

- Four Node tests passed.
- Eight Python tests passed against the pinned prepared source. Only temporary copies were patched.
- Browser component checks passed at 1280 px and 360 px. No horizontal overflow; keyboard focus and expandable guide checked. Light and dark rendering inspected.

## Native runtime acceptance

Source assertions do not prove native import, authentication prompts, persistent storage, edit/delete, save/update bubbles, or autofill at runtime. Verify the compiled app using a disposable profile and the committed dummy fixture only.

1. Launch the compiled Breezer with a new temporary `--user-data-dir`. Do not use an existing Breezer or Chrome profile. The browser may create/access its Breezer Keychain item, so Main should run on its isolated test account if existing Keychain identity must also be isolated.
2. Open the settings Passwords entry. Check the guide, then cancel the native CSV file picker once. No successful-import message should appear in the component.
3. Select `tests/passwords/dummy.csv` through **Import password CSV**. Expect one import into the device/profile store. Review the native result and find `dummy@example.test` in the native manager. Do not record or print any other credential.
4. Open the dummy entry, cancel OS authentication first and verify details remain unavailable. Retry and authenticate. View and edit only this dummy entry; close/reopen the manager to confirm the edit persists. Authentication may be cached according to Chromium's native validity period.
5. With the local fixture server running, visit `http://localhost:8765/tests/passwords/login.html`. Focus the username/password field and select the imported dummy suggestion. Confirm both fields autofill and the native manage-passwords footer opens Breezer's manager. Do not log field values or dump the database.
6. Restart that disposable profile and confirm the dummy entry persists. Delete it in the native manager, then reopen the fixture and confirm it is no longer offered. Test native saving/update with a dummy local login fixture if required by Main's broader save-flow verification.
7. For importer conflict/error acceptance, edit the dummy CSV in a temporary copy and import it again. Review the native duplicate/conflict outcome; cancel once and then complete a dummy replacement. Import a malformed dummy file and verify native failure is shown without a component success claim.
8. Confirm real enterprise password restrictions are respected if applicable. Test source-file deletion only on a temporary copy of the dummy CSV. Remove disposable fixture copies/profile after review.

Return native runtime results to Main separately. Until those steps pass, claim verified UI routing and source integration only.

### Windows import smoke

Run on an unlocked Windows desktop with the compiled Breezer binary and its matching ChromeDriver:

```powershell
python script/windows/smoke_import.py --browser C:\path\to\chrome.exe --driver C:\path\to\chromedriver.exe
```

The smoke test uses a fresh Breezer profile, imports a synthetic bookmarks HTML file and a copy of the committed dummy CSV through the standard Windows file pickers, then checks both saved entries in Chromium's native pages.

To check Firefox direct import, use a standard 64-bit Firefox installation in Program Files and a disposable Windows account where Firefox has only one profile named `Breezer import smoke`. In Firefox's password manager, add a single synthetic login for `https://breezer-firefox-smoke.example.test/` with username `dummy-firefox@example.test` and any dummy password. Close Firefox and rerun with `--firefox-fixture`. The check confirms **Saved passwords** starts unchecked, enables it and verifies the dummy entry.

Run `python tests/windows_import_test.py` for the Windows patch contract checks. Set `BREEZER_WINDOWS_IMPORT_SOURCE` to the prepared Windows source directory to check the compiled source inputs.
