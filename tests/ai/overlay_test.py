"""Offline checks for the packaged browser/host identity boundary."""

import base64
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class BundledIdentityTest(unittest.TestCase):
    def test_manifest_key_and_native_host_are_bound_to_the_same_extension(self):
        identity = json.loads((ROOT / 'features/ai/integration/identity.json').read_text())
        manifest = json.loads((ROOT / 'features/ai/extension/manifest.json').read_text())
        host = json.loads((ROOT / 'features/ai/integration/native-host-manifest.json').read_text())
        digest = hashlib.sha256(base64.b64decode(manifest['key'])).hexdigest()[:32]
        extension_id = ''.join(chr(ord('a') + int(n, 16)) for n in digest)
        self.assertEqual(identity['extension_id'], extension_id)
        self.assertEqual(identity['public_key'], manifest['key'])
        self.assertEqual(host['allowed_origins'], [f'chrome-extension://{extension_id}/'])
        self.assertEqual(host['name'], identity['native_host'])
        self.assertEqual(host['path'], 'host/launch.sh')
        self.assertEqual(host['type'], 'stdio')

    def test_packaged_extension_requires_an_explicit_page_grant(self):
        manifest = json.loads((ROOT / 'features/ai/extension/manifest.json').read_text())
        self.assertIn('activeTab', manifest['permissions'])
        self.assertEqual(manifest['host_permissions'], ['https://breezer-browser.vercel.app/*'])
        self.assertEqual(manifest['incognito'], 'not_allowed')
        self.assertIn('connect-src https://breezer-browser.vercel.app', manifest['content_security_policy']['extension_pages'])
        self.assertEqual(manifest['background']['type'], 'module')
        self.assertEqual(manifest['side_panel']['default_path'], 'panel.html')
        self.assertTrue((ROOT / 'features/ai/extension/panel.html').is_file())


if __name__ == '__main__':
    unittest.main()
