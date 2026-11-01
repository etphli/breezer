"""Pinned-source integration only, never biometric or compiled-browser proof.

BREEZER_PASSWORD_SOURCE is read only. Overlay writes use disposable copies.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('overlay', ROOT / 'features/passwords/native-ui/apply.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)
SOURCE = os.environ.get('BREEZER_PASSWORD_SOURCE')
MANIFEST = json.loads((ROOT / 'features/passwords/native-ui/upstream.json').read_text())


@unittest.skipUnless(SOURCE, 'Set BREEZER_PASSWORD_SOURCE to a disposable pinned source fixture')
class PasskeySourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='breezer-passkeys-source-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.tree = Path(cls.directory.name)
        cls.observed = {}
        for name in set(overlay.sections()) | set(MANIFEST['passkey_source_evidence_sha256']) | {
                'chrome/browser/resources/settings/route.ts',
                'chrome/browser/resources/settings/settings_main/settings_main.html'}:
            data = (Path(SOURCE) / name).read_bytes()
            cls.observed[name] = data
            target = cls.tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        overlay.apply(cls.tree)

    def read(self, name):
        return (self.tree / name).read_text()

    def test_native_preferences_and_real_policy_are_preserved(self):
        policy = self.read('chrome/browser/policy/configuration_policy_handler_list_factory.cc')
        self.assertNotIn('DisabledPasswordManagerPolicyHandler', policy)
        self.assertNotIn('DisabledPasskeysPolicyHandler', policy)
        self.assertNotIn('prefs->SetBoolean(password_manager::prefs::kCredentialsEnablePasskeys', policy)
        self.assertIn('key::kPasswordManagerEnabled', policy)
        prefs = self.read('components/password_manager/core/browser/password_manager.cc')
        self.assertIn('prefs::kCredentialsEnablePasskeys, true', prefs)
        self.assertIn('prefs::kCredentialsEnableService, true', prefs)
        self.assertIn('prefs::kCredentialsEnableAutosignin, false', prefs)

    def test_native_management_route_is_mounted_and_lazy_loaded_on_mac(self):
        route = self.read('chrome/browser/resources/settings/route.ts')
        self.assertIn('r.PASSKEYS = r.ADVANCED.createSection(', route)
        mac_routes = route.split('// <if expr="is_macosx">', 1)[1].split('// </if>', 1)[0]
        self.assertIn('r.PASSKEYS = r.ADVANCED.createSection(', mac_routes)
        self.assertIn("'/passkeys', 'passkeys'", mac_routes)
        main = self.read('chrome/browser/resources/settings/settings_main/settings_main.html')
        mac_template = main.split('<if expr="is_macosx">', 1)[1].split('</if>', 1)[0]
        self.assertIn('routes_.PASSKEYS, lastRoute_, inSearchMode_', mac_template)
        self.assertIn('<settings-passkeys-page slot="view" id="passkeys"', mac_template)
        self.assertIn('hidden-by-search$="[[inSearchMode_]]"', mac_template)
        # The native page is a direct view, not a SettingsPlugin. Wrapping it
        # in a slot=view div would make native Settings search call a missing
        # searchContents method. Its own native search/filter remains intact.
        self.assertNotIn('<div slot="view"', mac_template)
        lazy = self.read('chrome/browser/resources/settings/lazy_load.ts')
        self.assertIn("import './autofill_page/passwords/passkeys_page.js'", lazy)
        main_ts = self.read('chrome/browser/resources/settings/settings_main/settings_main.ts')
        self.assertIn('routes.ADVANCED.contains(route)', main_ts)
        self.assertIn('ensureLazyLoaded()', main_ts)
        self.assertIn('std::make_unique<PasskeysHandler>()', self.read('chrome/browser/ui/webui/settings/settings_ui.cc'))

    def test_platform_identity_authentication_and_storage_are_unchanged(self):
        config = self.read('chrome/browser/webauthn/chrome_web_authentication_delegate.cc')
        self.assertIn('MAC_TEAM_IDENTIFIER_STRING "." MAC_BUNDLE_IDENTIFIER_STRING ".webauthn"', config)
        self.assertIn('kWebAuthnTouchIdMetadataSecretPrefName', config)
        touch = self.read('device/fido/mac/touch_id_context.mm')
        for gate in ['ExecutableHasKeychainAccessGroupEntitlement(', 'LAPolicyDeviceOwnerAuthentication', 'CanCreateSecureEnclaveKeyPairBlocking()', '[context_ invalidate]']:
            self.assertIn(gate, touch)
        store = self.read('device/fido/mac/credential_store.mm')
        self.assertIn('CFToNSPtrCast(kSecAttrSynchronizable) : @NO', store)
        self.assertIn('kSecAttrTokenIDSecureEnclave', store)
        self.assertIn('config_.metadata_secret', store)
        self.assertIn('config_.keychain_access_group', store)
        icloud = self.read('device/fido/mac/icloud_keychain_sys.mm')
        self.assertIn('com.apple.developer.web-browser.public-key-credential', icloud)
        self.assertIn('static bool available = ProcessHasEntitlement()', icloud)
        for name, expected in MANIFEST['passkey_source_evidence_sha256'].items():
            self.assertEqual(hashlib.sha256((self.tree / name).read_bytes()).hexdigest(), expected, name)

    def test_management_uses_same_profile_store_and_native_confirmation(self):
        manager = self.read('chrome/browser/webauthn/local_credential_management_mac.cc')
        self.assertIn('TouchIdAuthenticatorConfigForProfile(', manager)
        self.assertIn('FindResidentCredentials(', manager)
        self.assertIn('credential_store.DeleteCredentialById(credential_id)', manager)
        self.assertIn('credential_store.UpdateCredential(', manager)
        page = self.read('chrome/browser/resources/settings/autofill_page/passwords/passkeys_page.ts')
        for behavior in ['showDeleteConfirmationDialog_ = true', 'dialog.wasConfirmed()', 'if (confirmed)', 'this.browserProxy_.delete(', 'this.browserProxy_.edit(', 'noManagement_ = true']:
            self.assertIn(behavior, page)

    def test_origin_rp_and_native_selection_pipeline_are_unchanged(self):
        common = self.read('content/browser/webauth/authenticator_common_impl.cc')
        self.assertGreaterEqual(common.count('ValidateDomainAndRelyingPartyID('), 2)
        self.assertGreaterEqual(common.count('ValidateAncestorOrigins('), 2)
        self.assertIn('WebAuthn.MakeCredential.Aborted', common)
        self.assertIn('WebAuthn.GetAssertion.Aborted', common)
        delegate = self.read('chrome/browser/webauthn/chrome_authenticator_request_delegate.cc')
        self.assertIn('ConfigureICloudKeychain(', delegate)
        self.assertIn('password_manager::prefs::kCredentialsEnablePasskeys', delegate)
        self.assertIn('gpm_create_available_but_disabled_by_policy', delegate)
        for name, data in self.observed.items():
            self.assertEqual((Path(SOURCE) / name).read_bytes(), data, 'supplied source changed')


if __name__ == '__main__':
    unittest.main()
