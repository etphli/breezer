"""The AI overlay fixture is bound to the reviewed Chromium version. No downloads."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'script'
sys.path.insert(0, str(SCRIPT))
spec = importlib.util.spec_from_file_location('overlay_version', SCRIPT / 'check_ai_overlay.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class FixtureVersionTest(unittest.TestCase):
    def test_pinned_version_matches_upstream_and_names_the_cache(self):
        lock = json.loads((ROOT / 'upstream.lock.json').read_text())
        upstream = (ROOT / lock['helium']['path'] / 'chromium_version.txt').read_text().strip()
        self.assertEqual(overlay.VERSION, upstream)
        self.assertEqual(overlay.CACHE, ROOT / 'build/ai-check' / upstream / 'pristine')

    def test_changed_upstream_version_rejects_before_any_fetch_or_cache_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'repo'
            helium = root / 'upstream/helium'
            helium.mkdir(parents=True)
            (helium / 'chromium_version.txt').write_text('157.0.8100.1\n')
            (root / 'upstream.lock.json').write_text(json.dumps({'helium': {'path': 'upstream/helium'}}))
            fetched = []
            for offline in (False, True):
                with self.subTest(offline=offline), patch.object(overlay.ai, 'ROOT', root), \
                        patch.object(overlay, 'fetch', side_effect=fetched.append), \
                        patch.object(overlay, 'upstream_series', side_effect=AssertionError('read patches')):
                    with self.assertRaisesRegex(ValueError, r'157\.0\.8100\.1'):
                        overlay.prepare(Path(directory) / f'tree-{offline}', offline=offline)
            self.assertEqual(fetched, [])
            self.assertFalse(any(Path(directory).glob('tree-*')))


if __name__ == '__main__':
    unittest.main()
