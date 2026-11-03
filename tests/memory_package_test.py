"""All packaged host modules must match the tested native host receipt."""
import hashlib
import json
from pathlib import Path
import plistlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'script'))
from check_breezer_memory_package import verify
import package_breezer_ai as packaging


class MemoryPackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='breezer-memory-package-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.app = root / 'Breezer.app'
        self.host = self.app / 'Contents/Frameworks/Breezer Framework.framework/Versions/156/Resources/breezer_ai/host'
        self.host.mkdir(parents=True)
        with (self.app / 'Contents/Info.plist').open('wb') as stream:
            plistlib.dump({'CFBundleIdentifier': 'io.github.etphli.breezer', 'CFBundleExecutable': 'Breezer'}, stream)
        self.protocol = self.host / 'protocol.mjs'
        self.protocol.write_text('tested decoder')
        self.packet = root / 'packet'
        self.packet.mkdir()
        resources = {}
        for path in (packaging.FEATURE / 'host').glob('*.mjs'):
            content = b'tested decoder' if path.name == 'protocol.mjs' else ('tested ' + path.name).encode()
            (self.host / path.name).write_bytes(content)
            (self.packet / ('host-' + path.name)).write_bytes(content)
            resources[path.name] = hashlib.sha256(content).hexdigest()
        (self.packet / 'host-update.json').write_text(json.dumps({'resource': 'breezer_ai/host/protocol.mjs',
            'after': resources['protocol.mjs'], 'hostResources': resources}))

    def test_accepts_matching_packaged_host(self):
        result = verify(self.app, self.packet)
        self.assertEqual(Path(result['resources']['protocol.mjs']['resource']), self.protocol.resolve())
        self.assertEqual(len(result['resources']), len(list((packaging.FEATURE / 'host').glob('*.mjs'))))

    def test_package_command_enforces_the_memory_receipt(self):
        def unpack(_archive, destination, _distribution):
            destination.mkdir()
            (destination / 'node').write_text('fixture runtime')
        with patch.object(packaging, 'download_runtime', return_value=Path('fixture-archive')), \
             patch.object(packaging, 'unpack_runtime', side_effect=unpack), \
             patch.object(packaging.platform, 'system', return_value='Linux'), \
             patch.object(packaging.subprocess, 'check_output', return_value='a' * 40):
            # The source checkout differs from the synthetic tested-decoder receipt.
            with self.assertRaisesRegex(ValueError, 'does not match'):
                packaging.package(self.app, 'arm64', self.packet, memory_packet=self.packet)

    def test_rejects_stale_packaged_host(self):
        self.protocol.write_text('old decoder')
        with self.assertRaisesRegex(ValueError, 'does not match'):
            verify(self.app, self.packet)

    def test_rejects_stale_claude_with_a_matching_decoder(self):
        (self.host / 'claude.mjs').write_text('old streaming parser')
        with self.assertRaisesRegex(ValueError, 'does not match.*claude'):
            verify(self.app, self.packet)

    def test_rejects_an_incomplete_host_receipt(self):
        path = self.packet / 'host-update.json'
        manifest = json.loads(path.read_text())
        del manifest['hostResources']['claude.mjs']
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'resource set'):
            verify(self.app, self.packet)

    def test_rejects_an_unknown_host_receipt_path(self):
        path = self.packet / 'host-update.json'
        manifest = json.loads(path.read_text())
        manifest['hostResources']['../escape.mjs'] = 'unknown'
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'resource set'):
            verify(self.app, self.packet)

    def test_rejects_corrupt_packet(self):
        (self.packet / 'host-protocol.mjs').write_text('corrupt decoder')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            verify(self.app, self.packet)

    def test_rejects_host_symlink(self):
        self.protocol.unlink()
        self.protocol.symlink_to(self.packet / 'host-protocol.mjs')
        with self.assertRaisesRegex(ValueError, 'inside the app'):
            verify(self.app, self.packet)


if __name__ == '__main__':
    unittest.main()
