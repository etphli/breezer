#!/usr/bin/env python3
"""Check extension, native display and bundle release versions without building."""

import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

import apply_breezer_branding as branding
from breezer_release import release_version
import package_breezer_ai as packaging
from package_breezer_ai import stamp_bundle_version


class ReleaseVersionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.extension = self.root / 'features/ai/extension'
        self.extension.mkdir(parents=True)
        (self.extension / 'release-info.js').write_text("export const RELEASE_VERSION = '1.2.0';\n")
        (self.extension / 'manifest.json').write_text(json.dumps({'version': '1.2.0'}))

    def test_release_metadata_agrees_and_rejects_ambiguous_versions(self):
        self.assertEqual(release_version(self.root), '1.2.0')
        (self.extension / 'manifest.json').write_text(json.dumps({'version': '1.1.5'}))
        with self.assertRaisesRegex(ValueError, 'versions differ'):
            release_version(self.root)
        (self.extension / 'manifest.json').write_text(json.dumps({'version': '1.2.0'}))
        for version in ['v1.2.0', '1.2', '1.2.0-beta', '01.2.0']:
            (self.extension / 'release-info.js').write_text(f"export const RELEASE_VERSION = '{version}';\n")
            with self.subTest(version=version), self.assertRaises(ValueError):
                release_version(self.root)

    def test_native_display_uses_release_and_preserves_chromium_version(self):
        path = self.root / 'base/version_info/version_info_values.h.version'
        path.parent.mkdir(parents=True)
        engine = '#define PRODUCT_VERSION "@MAJOR@.@MINOR@.@BUILD@.@PATCH@"\n'
        path.write_text(engine + '#define HELIUM_PRODUCT_VERSION "@HELIUM_MAJOR@.@HELIUM_MINOR@.@HELIUM_PATCH@.@HELIUM_PLATFORM@"\n')
        with patch.object(branding, 'ROOT', self.root):
            branding.brand_version(self.root)
            first = path.read_bytes()
            branding.brand_version(self.root)
        self.assertEqual(first, path.read_bytes())
        self.assertEqual(path.read_text(), engine + '#define HELIUM_PRODUCT_VERSION "1.2.0"\n')

    def test_bundle_version_changes_only_the_public_breezer_app(self):
        app = self.root / 'Breezer.app'
        info = app / 'Contents/Info.plist'
        info.parent.mkdir(parents=True)
        original = {'CFBundleIdentifier': 'io.github.etphli.breezer', 'CFBundleExecutable': 'Breezer',
                    'CFBundleShortVersionString': '0.20.1.1', 'CFBundleVersion': '0.20.1.1'}
        info.write_bytes(plistlib.dumps(original, fmt=plistlib.FMT_BINARY))
        framework = app / 'Contents/Frameworks/Breezer Framework.framework/Versions/156.0.8078.47/Resources/Info.plist'
        framework.parent.mkdir(parents=True)
        framework.write_bytes(plistlib.dumps({'CFBundleVersion': '156.0.8078.47'}))
        before = framework.read_bytes()
        stamp_bundle_version(app, release_version(self.root))
        value = plistlib.loads(info.read_bytes())
        self.assertEqual(value, {**original, 'CFBundleShortVersionString': '1.2.0', 'CFBundleVersion': '1.2.0'})
        self.assertTrue(info.read_bytes().startswith(b'bplist'))
        self.assertEqual(framework.read_bytes(), before)

    def test_foreign_bundle_and_symlink_are_refused(self):
        app = self.root / 'Other.app'
        info = app / 'Contents/Info.plist'
        info.parent.mkdir(parents=True)
        data = plistlib.dumps({'CFBundleIdentifier': 'com.google.Chrome', 'CFBundleVersion': '156'})
        info.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'Only the Breezer app'):
            stamp_bundle_version(app, '1.2.0')
        self.assertEqual(info.read_bytes(), data)
        outside = self.root / 'outside.plist'
        outside.write_bytes(data)
        info.unlink()
        info.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            stamp_bundle_version(app, '1.2.0')
        self.assertEqual(outside.read_bytes(), data)

    def test_full_package_keeps_release_version_separate_from_node_version(self):
        feature = self.root / 'features/ai'
        (feature / 'host').mkdir()
        (feature / 'host/launch.sh').write_text('#!/bin/sh\n')
        (feature / 'integration').mkdir()
        (feature / 'integration/native-host-manifest.json').write_text('{}')
        (feature / 'runtime.lock.json').write_text(json.dumps({
            'version': '24.22.1', 'distributions': {'arm64': {}}}))
        app = self.root / 'Breezer.app'
        info = app / 'Contents/Info.plist'
        info.parent.mkdir(parents=True)
        info.write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'io.github.etphli.breezer',
            'CFBundleExecutable': 'Breezer', 'CFBundleVersion': '0.20.1.1'}))
        resources = app / 'Contents/Frameworks/Breezer Framework.framework/Versions/156/Resources'
        resources.mkdir(parents=True)
        with patch.object(packaging, 'ROOT', self.root), \
                patch.object(packaging, 'FEATURE', feature), \
                patch.object(packaging, 'download_runtime', return_value=self.root / 'node.tar.gz'), \
                patch.object(packaging, 'unpack_runtime',
                             side_effect=lambda archive, destination, distribution: destination.mkdir()), \
                patch.object(packaging.platform, 'system', return_value='Darwin'), \
                patch.object(packaging.platform, 'machine', return_value='arm64'), \
                patch.object(packaging.subprocess, 'check_output',
                             side_effect=['a' * 40, 'v24.22.1\n', 'arm64\n']):
            packaging.package(app, 'arm64', self.root / 'cache')
        value = plistlib.loads(info.read_bytes())
        self.assertEqual(value['CFBundleVersion'], '1.2.0')
        self.assertEqual(value['CFBundleShortVersionString'], '1.2.0')


if __name__ == '__main__':
    unittest.main(verbosity=2)
