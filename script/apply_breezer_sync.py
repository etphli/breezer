#!/usr/bin/env python3
"""Apply Breezer sync wiring after Helium and workspace preparation, before GN.

This tool stages and validates every anchor before any writes. It preserves
outputs and never opens a profile, accesses credentials or installs an app.
"""
import argparse
import hashlib
import os
from pathlib import Path
import tempfile

import apply_breezer_workspace as workspace

ROOT = Path(__file__).resolve().parent.parent
NATIVE = ROOT / 'features/sync/native'
SETUP = ROOT / 'features/sync/setup'


def replacements():
    def insert(anchor, content):
        return (anchor, anchor + content)
    return {
        'chrome/browser/sync/chrome_sync_client.h': [
            insert('#include "extensions/buildflags/buildflags.h"\n', '\nclass Profile;\n'),
            ('std::unique_ptr<ExtensionsActivityMonitor> extensions_activity_monitor);',
             'std::unique_ptr<ExtensionsActivityMonitor> extensions_activity_monitor,\n      Profile* sync_profile = nullptr);'),
            insert('  base::FilePath GetLocalSyncBackendFolder() override;\n', '''  bool IsCustomSyncBackendConfigured() const override;
  syncer::CustomSyncBackendStatus GetCustomSyncBackendStatus() const override;
  std::string GetCustomSyncBackendNamespace() const override;
  std::unique_ptr<syncer::CustomSyncBackend> CreateCustomSyncBackend(
      scoped_refptr<os_crypt_async::Encryptor> encryptor) override;
'''),
            insert('  const base::FilePath profile_base_name_;\n', '  const raw_ptr<Profile> sync_profile_;\n'),
        ],
        'chrome/browser/sync/chrome_sync_client.cc': [
            insert('#include "chrome/browser/sync/chrome_sync_client.h"\n', '#include "chrome/browser/sync/breezer_sync/backend.h"\n#include "components/sync/engine/custom_sync_backend.h"\n#include "components/os_crypt/async/common/encryptor.h"\n'),
            ('std::unique_ptr<ExtensionsActivityMonitor> extensions_activity_monitor)\n',
             'std::unique_ptr<ExtensionsActivityMonitor> extensions_activity_monitor,\n    Profile* sync_profile)\n'),
            insert('    : profile_base_name_(profile_base_name),\n', '      sync_profile_(sync_profile),\n'),
            ('data_type_store_service->GetSyncDataPath()) {\n  DCHECK_CURRENTLY_ON(BrowserThread::UI);\n}',
             'data_type_store_service->GetSyncDataPath()) {\n  DCHECK_CURRENTLY_ON(BrowserThread::UI);\n  breezer_sync::PrepareProfile(sync_profile_);\n}'),
            ('base::FilePath ChromeSyncClient::GetLocalSyncBackendFolder() {', '''bool ChromeSyncClient::IsCustomSyncBackendConfigured() const {
  return breezer_sync::IsConfigured(sync_profile_);
}
syncer::CustomSyncBackendStatus ChromeSyncClient::GetCustomSyncBackendStatus() const {
  return breezer_sync::GetBackendStatus(sync_profile_);
}
std::string ChromeSyncClient::GetCustomSyncBackendNamespace() const {
  return breezer_sync::GetBackendNamespace(sync_profile_);
}
std::unique_ptr<syncer::CustomSyncBackend> ChromeSyncClient::CreateCustomSyncBackend(
    scoped_refptr<os_crypt_async::Encryptor> encryptor) {
  return breezer_sync::CreateBackend(sync_profile_, std::move(encryptor));
}

base::FilePath ChromeSyncClient::GetLocalSyncBackendFolder() {'''),
        ],
        'chrome/browser/sync/sync_service_factory.cc': [
            insert('#include "chrome/browser/sync/chrome_sync_client.h"\n', '#include "chrome/browser/extensions/api/sync_vault_provider/sync_vault_provider_service.h"\n#include "chrome/browser/sync/private_sync/private_sync_repository.h"\n'),
            ('std::make_unique<browser_sync::ExtensionsActivityMonitor>(profile));',
             'std::make_unique<browser_sync::ExtensionsActivityMonitor>(profile), profile);'),
            insert('  DependsOn(ProfilePasswordStoreFactory::GetInstance());\n', '  DependsOn(extensions::SyncVaultProviderServiceFactory::GetInstance());\n  DependsOn(browser_sync::private_sync::Repository::GetFactory());\n'),
        ],
        'chrome/browser/sync/BUILD.gn': [
            insert('    "chrome_sync_client.cc",\n', '''    "breezer_sync/backend.cc",
    "breezer_sync/backend.h",
    "breezer_sync/prefs.h",
    "breezer_sync/provider_transport.cc",
    "breezer_sync/provider_transport.h",
'''),
            insert('  deps = [\n    ":data_type_store_service_factory",\n', '''    "//chrome/browser/extensions/api/sync_vault_provider",
    "//components/os_crypt/async/common",
    "//components/sync/engine/sync_vault",
'''),
        ],
        'chrome/browser/prefs/browser_prefs.cc': [
            insert('  browser_sync::private_sync_prefs::RegisterProfilePrefs(registry);\n', '''  registry->RegisterStringPref("breezer.sync.workspace", "",
      user_prefs::PrefRegistrySyncable::SYNCABLE_PREF);
'''),
        ],
        'chrome/browser/sync/prefs/chrome_syncable_prefs_database.cc': [
            insert('  kTtcAutoPinnedMigration = 100387,\n', '  kBreezerWorkspace = 199999,\n'),
            insert('    sync_preferences::SyncablePrefMetadata>({\n', '''    {"breezer.sync.workspace",
     {syncable_prefs_ids::kBreezerWorkspace, syncer::PREFERENCES, sync_preferences::PrefSensitivity::kNone,
      sync_preferences::MergeBehavior::kNone,
      sync_preferences::WriteBehavior::kWriteToBoth}},
'''),
        ],
        'tools/metrics/histograms/metadata/sync/enums.xml': [
            insert('  <int value="100387" label="TtcAutoPinnedMigration"/>\n', '  <int value="199999" label="BreezerWorkspace"/>\n'),
        ],
        'components/sync/base/data_type.cc': [
            ('      NIGORI, PREFERENCES, PRIORITY_PREFERENCES, READING_LIST,',
             '      NIGORI, PASSWORDS, PREFERENCES, PRIORITY_PREFERENCES, READING_LIST,'),
        ],
        'extensions/common/extension_features.cc': [
            ('BASE_FEATURE(kApiSyncVaultProvider, base::FEATURE_DISABLED_BY_DEFAULT);',
             'BASE_FEATURE(kApiSyncVaultProvider, base::FEATURE_ENABLED_BY_DEFAULT);'),
        ],
        'chrome/browser/ui/webui/chrome_web_ui_configs.cc': [
            insert('#include "chrome/browser/ui/webui/chrome_web_ui_configs.h"\n', '#include "chrome/browser/ui/webui/breezer_sync/breezer_sync_ui.h"\n'),
            insert('  auto& map = content::WebUIConfigMap::GetInstance();\n', '  map.AddWebUIConfig(std::make_unique<breezer_sync::BreezerSyncUIConfig>());\n'),
        ],
        'chrome/browser/ui/webui/BUILD.gn': [
            insert('    ":gcm_internals_ui",\n', '    "//chrome/browser/ui/webui/breezer_sync",\n'),
        ],
    }


def added_files():
    files = {path.relative_to(NATIVE).as_posix(): path.read_bytes() for path in NATIVE.rglob('*') if path.is_file()}
    header = '#include <string_view>\nnamespace breezer_sync {\n'
    for file, name in [('setup.html', 'kSetupHtml'), ('setup.js', 'kSetupScript'), ('setup.css', 'kSetupStyle')]:
        value = (SETUP / file).read_text()
        if ')BreezerSync"' in value:
            raise ValueError('Invalid setup resource delimiter')
        header += f'inline constexpr std::string_view {name} = R"BreezerSync({value})BreezerSync";\n'
    files['chrome/browser/ui/webui/breezer_sync/setup_resources.h'] = (header + '}\n').encode()
    return files


def fingerprint():
    digest = hashlib.sha256()
    for path in sorted([Path(__file__).resolve(), *[p for directory in (NATIVE, SETUP) for p in directory.rglob('*') if p.is_file()]]):
        digest.update(path.relative_to(ROOT).as_posix().encode() + b'\0')
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def transform(name, original):
    text = original.decode()
    for before, after in replacements()[name]:
        if text.count(after) == 1:
            continue
        if text.count(before) != 1:
            raise ValueError(f'Sync anchor drift in {name}: {before[:100]!r}')
        text = text.replace(before, after, 1)
    return text.encode()


def apply(tree, check=False):
    tree = Path(tree).resolve()
    originals = {name: workspace.source_file(tree, name).read_bytes() for name in replacements()}
    plans = {name: transform(name, content) for name, content in originals.items()}
    for name, content in added_files().items():
        target = workspace._reject_symlinks(tree, name)
        existing = target.read_bytes() if target.is_file() else None
        originals[name] = existing
        if existing is not None and existing != content:
            raise ValueError(f'Installed sync source differs: {name}; use a fresh preparation')
        plans[name] = content
    changes = {name: content for name, content in plans.items() if originals[name] != content}
    if check and changes:
        raise ValueError('Sync overlay is missing: ' + ', '.join(changes))
    for name, previous in originals.items():
        path = workspace._reject_symlinks(tree, name)
        if (path.read_bytes() if path.is_file() else None) != previous:
            raise ValueError(f'Source changed while staging sync: {name}')
    for name, content in changes.items():
        destination = tree / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.breezer-sync-', delete=False) as output:
            output.write(content)
            temporary = Path(output.name)
        try:
            if destination.exists(): os.chmod(temporary, destination.stat().st_mode & 0o777)
            else: os.chmod(temporary, 0o644)
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
    return len(changes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_tree', nargs='?', type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--fingerprint', action='store_true')
    args = parser.parse_args()
    if args.fingerprint:
        print(fingerprint()); return
    if not args.source_tree: parser.error('Provide a prepared source tree')
    try:
        print(f'Breezer sync overlay verified; {apply(args.source_tree, args.check)} files changed.')
    except (OSError, ValueError) as error:
        parser.exit(1, f'Cannot prepare Breezer sync: {error}\n')


if __name__ == '__main__':
    main()
