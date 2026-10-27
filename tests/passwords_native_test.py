"""Source-only checks. BREEZER_PASSWORD_SOURCE is read, never patched in place."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / 'features/passwords/native-ui'
spec = importlib.util.spec_from_file_location('password_overlay', NATIVE / 'apply.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)
SOURCE = os.environ.get('BREEZER_PASSWORD_SOURCE')


class OverlayBoundaryTest(unittest.TestCase):
    def test_fingerprint_and_targets(self):
        self.assertRegex(overlay.fingerprint(), r'^[0-9a-f]{64}$')
        self.assertEqual(set(overlay.sections()), {
            'chrome/browser/policy/configuration_policy_handler_list_factory.cc',
            'components/password_manager/core/browser/password_suggestion_generator.cc',
            'chrome/browser/ui/browser_actions.cc',
            'chrome/browser/ui/web_applications/app_browser_controller.cc',
        })

    def test_missing_source_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'Missing prepared source'):
                overlay.apply(directory)
            self.assertFalse(list(Path(directory).iterdir()))


@unittest.skipUnless(SOURCE, 'Set BREEZER_PASSWORD_SOURCE to read a prepared pinned source tree')
class PinnedSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = Path(SOURCE)
        cls.originals = {name: (cls.source / name).read_bytes() for name in overlay.sections()}

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='breezer-passwords-test-')
        self.addCleanup(self.directory.cleanup)
        self.tree = Path(self.directory.name)
        for name, data in self.originals.items():
            target = self.tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

    def read(self, name):
        return (self.source / name).read_text()

    def test_pinned_routes_and_storage_authentication_contract(self):
        version = self.read('chrome/VERSION')
        self.assertTrue(all(value in version for value in ['MAJOR=156', 'BUILD=8078', 'PATCH=47']))
        self.assertIn('std::make_unique<PasswordManagerUIConfig>()', self.read('chrome/browser/ui/webui/chrome_web_ui_configs.cc'))
        router = self.read('chrome/browser/resources/password_manager/router.ts')
        self.assertIn("PASSWORDS = 'passwords'", router)
        self.assertIn("SETTINGS = 'settings'", router)
        self.assertIn("START_IMPORT = 'import'", router)
        settings = self.read('chrome/browser/resources/password_manager/settings_section.ts')
        self.assertIn('newRoute.queryParameters.get(UrlParam.START_IMPORT)', settings)
        self.assertIn('importer.launchImport()', settings)
        importer = self.read('chrome/browser/resources/password_manager/passwords_importer.ts')
        self.assertIn('let destinationStore = chrome.passwordsPrivate.PasswordStoreSet.DEVICE;', importer)
        self.assertIn('this.passwordManager_.importPasswords(destinationStore)', importer)
        self.assertIn('continueImport(selectedIds)', importer)
        self.assertIn('resetImporter(deleteFile)', importer)
        feature_util = self.read('components/password_manager/core/browser/features/password_manager_features_util.cc')
        self.assertIn('syncer::GetUploadToGoogleState(sync_service, syncer::PASSWORDS)', feature_util)
        store = self.read('chrome/browser/password_manager/factories/profile_password_store_factory.cc')
        self.assertIn('CreatePasswordStoreBackend(password_manager::kProfileStore,', store)
        self.assertIn('profile->GetPath(), profile->GetPrefs()', store)
        self.assertIn('g_browser_process->os_crypt_async()', store)
        database = self.read('components/password_manager/core/browser/password_store/login_database.cc')
        self.assertIn('encryptor_->EncryptString(plain_text_utf8, cipher_text)', database)
        self.assertIn('EncryptedString(cred.password_value.secure_value()', database)
        keychain = self.read('components/os_crypt/common/keychain_password_mac.mm')
        self.assertIn('Breezer Storage Key', keychain)
        self.assertIn('kDefaultAccountName[] = "Breezer"', keychain)
        delegate = self.read('chrome/browser/extensions/api/passwords_private/passwords_private_delegate_impl.cc')
        for method in ['RequestPlaintextPassword', 'RequestCredentialsDetails', 'ChangeCredential', 'RemoveCredential', 'ImportPasswords']:
            self.assertIn(f'PasswordsPrivateDelegateImpl::{method}', delegate)
        self.assertIn('device_authenticator_->AuthenticateWithMessage(', delegate)
        details = delegate[delegate.index('void PasswordsPrivateDelegateImpl::RequestCredentialsDetails'):]
        self.assertIn('AuthenticateUser(', details.split('\n}', 1)[0])
        self.assertIn('saved_passwords_presenter_.EditSavedCredentials(', delegate)
        self.assertIn('saved_passwords_presenter_.RemoveCredential(', delegate)

    def test_direct_chrome_password_import_is_not_advertised(self):
        importer = self.read('chrome/utility/importer/chrome_importer.cc')
        self.assertIn('ImportBookmarks()', importer)
        self.assertIn('ImportHistory()', importer)
        self.assertNotIn('ImportPasswords', importer)
        self.assertNotIn('user_data_importer::PASSWORDS', importer)
        profiles = self.read('chrome/browser/importer/importer_list.cc')
        self.assertIn('profile.services_supported &= ~(user_data_importer::PASSWORDS', profiles)

    def test_apply_check_and_retry_on_source_copy_only(self):
        self.assertEqual(overlay.apply(self.tree), 4)
        self.assertEqual(overlay.apply(self.tree), 0)
        self.assertEqual(overlay.apply(self.tree, check=True), 0)
        policy = (self.tree / 'chrome/browser/policy/configuration_policy_handler_list_factory.cc').read_text()
        self.assertNotIn('prefs->SetBoolean(password_manager::prefs::kCredentialsEnableService,', policy)
        self.assertIn('prefs->SetBoolean(password_manager::prefs::kCredentialsEnablePasskeys,', policy)
        actions = (self.tree / 'chrome/browser/ui/browser_actions.cc').read_text()
        self.assertIn('kActionShowPasswordsBubbleOrPage, IDS_VIEW_PASSWORDS', actions)
        self.assertIn('chrome::ManagePasswordsForPage(bwi)', actions)
        self.assertIn('chrome::ShowPasswordManager(bwi)', actions)
        footer = (self.tree / 'components/password_manager/core/browser/password_suggestion_generator.cc').read_text()
        self.assertNotIn('if ((true))', footer)
        for name, data in self.originals.items():
            self.assertEqual((self.source / name).read_bytes(), data, 'original source must stay untouched')

    def test_missing_overlay_and_drift_refused_without_partial_writes(self):
        with self.assertRaisesRegex(ValueError, 'overlay is missing'):
            overlay.apply(self.tree, check=True)
        target = self.tree / 'chrome/browser/ui/browser_actions.cc'
        target.write_text('unrecognized source\n')
        before = {name: (self.tree / name).read_bytes() for name in self.originals}
        with self.assertRaisesRegex(ValueError, 'Unrecognized or ambiguous'):
            overlay.apply(self.tree)
        self.assertEqual(before, {name: (self.tree / name).read_bytes() for name in before})

    def test_interrupted_apply_converges_and_symlink_refused(self):
        name, section = next(iter(overlay.sections().items()))
        self.assertEqual(overlay.patch(self.tree, section).returncode, 0)
        self.assertEqual(overlay.apply(self.tree), 3)
        self.assertEqual(overlay.apply(self.tree, check=True), 0)
        target = self.tree / name
        other = self.tree / 'redirected.cc'
        shutil.move(target, other)
        target.symlink_to(other)
        with self.assertRaisesRegex(ValueError, 'must not use symlinks'):
            overlay.apply(self.tree)

    def test_recorded_source_evidence(self):
        manifest = json.loads((NATIVE / 'upstream.json').read_text())
        for name, expected in manifest['source_evidence_sha256'].items():
            self.assertEqual(hashlib.sha256((self.source / name).read_bytes()).hexdigest(), expected, name)


if __name__ == '__main__':
    unittest.main()
