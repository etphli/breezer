"""Verify the Windows import contract against the pinned prepared source, when available."""

import os
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "features/passwords/native-ui"
CORE = ROOT / "upstream/helium-macos/helium-chromium/patches"
SOURCE = os.environ.get("BREEZER_WINDOWS_IMPORT_SOURCE")
IMPORTER_LIST = "chrome/browser/importer/importer_list.cc"
DIALOG = "chrome/browser/resources/settings/people_page/import_data_dialog.ts"
TEMPLATE = "chrome/browser/resources/settings/people_page/import_data_dialog.html.ts"
FIREFOX_PATH = "chrome/common/importer/firefox_importer_utils_win.cc"
FIREFOX_UTILS = "chrome/common/importer/firefox_importer_utils.h"
FIREFOX_IMPORTER = "chrome/utility/importer/firefox_importer.cc"
NSS_LOADER = "chrome/utility/importer/nss_decryptor_win.cc"
NSS_HEADER = "chrome/utility/importer/nss_decryptor_win.h"
FIREFOX_ONLY = """    if (!BUILDFLAG(IS_WIN) ||
        profile.importer_type != user_data_importer::TYPE_FIREFOX) {
      profile.services_supported &= ~user_data_importer::PASSWORDS;
    }"""
PASSWORDS_OFF = """        key: 'import_dialog_saved_passwords',
        type: chrome.settingsPrivate.PrefType.BOOLEAN,
        value: false,"""
PASSWORDS_REACTIVE = "savedPasswordsPref_: {type: Object}"
PASSWORDS_TRANSIENT = "if (checkbox.id !== 'importDialogSavedPasswords')"


class WindowsImportPatchTest(unittest.TestCase):
    def test_direct_password_import_is_a_windows_firefox_capability(self):
        patch = (NATIVE / "windows-import.patch").read_text()
        changes = "\n".join(line[1:] for line in patch.splitlines()
                            if line.startswith("+") and not line.startswith("+++"))
        self.assertEqual([line for line in patch.splitlines() if line.startswith("--- ")], [
            f"--- a/{FIREFOX_PATH}", f"--- a/{FIREFOX_UTILS}", f"--- a/{IMPORTER_LIST}",
            f"--- a/{FIREFOX_IMPORTER}", f"--- a/{NSS_HEADER}", f"--- a/{NSS_LOADER}",
            f"--- a/{DIALOG}", f"--- a/{TEMPLATE}",
        ])
        self.assertIn(FIREFOX_ONLY, changes)
        self.assertIn("if (!GetFirefoxPasswordImportPath().empty())", changes)
        self.assertIn("-      profile.services_supported ^= user_data_importer::PASSWORDS;", patch)
        self.assertIn("profile.services_supported &= ~user_data_importer::AUTOFILL_FORM_DATA;", changes)
        self.assertIn(PASSWORDS_OFF, changes)
        self.assertIn(PASSWORDS_REACTIVE, changes)
        self.assertIn(PASSWORDS_TRANSIENT, changes)
        self.assertIn('.pref="${this.savedPasswordsPref_}"', changes)

    def test_inherited_helium_series_disables_startup_auto_import(self):
        startup_patch = "iridium-browser/browser-disable-profile-auto-import-on-first-run.patch"
        self.assertIn(startup_patch, (CORE / "series").read_text().splitlines())
        self.assertIn("-      first_run::AutoImport(", (CORE / startup_patch).read_text())


@unittest.skipUnless(SOURCE, "Set BREEZER_WINDOWS_IMPORT_SOURCE to a prepared Windows Chromium tree")
class WindowsImportSourceTest(unittest.TestCase):
    def read(self, name):
        return (Path(SOURCE) / name).read_text(encoding="utf-8")

    def test_prepared_import_uses_native_opt_in(self):
        profiles = self.read(IMPORTER_LIST)
        self.assertIn(FIREFOX_ONLY, profiles)
        published_profiles = profiles.split("void ImporterList::SourceProfilesLoaded", 1)[1]
        self.assertNotIn("user_data_importer::PASSWORDS", published_profiles)
        self.assertNotIn("first_run::AutoImport(", self.read("chrome/browser/chrome_browser_main.cc"))

        handler = self.read("chrome/browser/ui/webui/settings/import_data_handler.cc")
        self.assertIn("selected_items & supported_items", handler)
        dialog = self.read(DIALOG)
        self.assertIn("checkbox.checked && !checkbox.hidden", dialog)
        self.assertIn(PASSWORDS_OFF, dialog)
        self.assertIn(PASSWORDS_REACTIVE, dialog)
        self.assertIn(PASSWORDS_TRANSIENT, dialog)
        template = self.read(TEMPLATE)
        self.assertIn('.pref="${this.savedPasswordsPref_}"', template)
        self.assertNotIn('pref-key="import_dialog_saved_passwords"', template)
        firefox = self.read(FIREFOX_IMPORTER)
        self.assertIn("NSSDecryptor decryptor", firefox)

    def test_windows_firefox_uses_registered_runtime_without_profile_modules(self):
        path = self.read(FIREFOX_PATH).split("GetFirefoxPasswordImportPath()", 1)[1]
        self.assertIn("registered = GetFirefoxInstallPathFromRegistry()", path)
        self.assertIn("base::NormalizeFilePath(registered, &install_path)", path)
        self.assertIn("protected_root.IsParent(install_path)", path)
        self.assertIn("resolved_library != library", path)
        firefox = self.read(FIREFOX_IMPORTER).split("NSSDecryptor decryptor;", 1)[1]
        windows = firefox.split("#else", 1)[0]
        self.assertIn("decryptor.Init(install_path, source_path_)", windows)
        self.assertNotIn("decryptor.Init(source_path_", windows)
        self.assertNotIn("decryptor.Init(app_path_", windows)
        loader = self.read(NSS_LOADER)
        self.assertIn("::LoadLibraryExW(library.value().c_str()", loader)
        self.assertIn("LOAD_LIBRARY_SEARCH_SYSTEM32", loader)
        self.assertIn("kNSSInitReadOnly | kNSSInitNoModuleDB | kNSSInitNoRootInit", loader)
        self.assertNotIn("SetDllDirectory", loader)

    def test_native_chrome_and_edge_importers_are_for_browser_data(self):
        profiles = self.read("chrome/browser/importer/chrome_importer_list.cc")
        self.assertIn("TYPE_CHROME", profiles)
        self.assertIn("TYPE_EDGE_CHROMIUM", profiles)
        importer = self.read("chrome/utility/importer/chrome_importer.cc")
        self.assertIn("ImportBookmarks()", importer)
        self.assertIn("ImportHistory()", importer)
        self.assertNotIn("user_data_importer::PASSWORDS", importer)


if __name__ == "__main__":
    unittest.main()
