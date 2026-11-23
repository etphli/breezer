"""Interrupted fixture downloads never become reusable cache entries."""
import base64
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'script'
sys.path.insert(0, str(SCRIPT))
spec = importlib.util.spec_from_file_location('overlay_fetch', SCRIPT / 'check_ai_overlay.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class FixtureDownloadTest(unittest.TestCase):
    @staticmethod
    def mock_curl(*responses):
        pending = iter(responses)

        def download(command, **kwargs):
            reply, payload, error = next(pending)
            Path(command[command.index('--output') + 1]).write_bytes(payload)
            return subprocess.CompletedProcess(command, reply, stderr=error)

        return patch.object(overlay.subprocess, 'run', side_effect=download)

    def test_failed_downloads_leave_no_cache_and_retry_publishes_complete_bytes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(overlay, 'CACHE', Path(directory)):
            destination = Path(directory) / 'source/file.cc'
            responses = [(18, b'partial', b'incomplete transfer'),
                         (0, b'invalid base64!', b''),
                         (0, b'complete pinned fixture', b'')]

            with self.mock_curl(*responses) as curl:
                with self.assertRaisesRegex(ValueError, r'(?s)incomplete transfer.*invalid base64 response'):
                    overlay.fetch('source/file.cc')
                self.assertFalse(destination.exists())
                self.assertEqual(list(destination.parent.iterdir()), [])
                self.assertEqual(overlay.fetch('source/file.cc'), destination)
                self.assertEqual(destination.read_bytes(), b'complete pinned fixture')
                self.assertEqual(overlay.fetch('source/file.cc'), destination)
                self.assertEqual(curl.call_count, 3)
                self.assertEqual(list(destination.parent.iterdir()), [destination])

    def test_rate_limited_download_uses_the_same_pinned_gitiles_tag(self):
        payload = b'complete pinned fixture\xff\r\n'
        responses = [(56, b'', b'HTTP 429'), (0, base64.b64encode(payload), b'')]
        version = '157.0.8100.1'
        name = 'source/file.cc'
        with tempfile.TemporaryDirectory() as directory, self.mock_curl(*responses) as curl:
            cache = Path(directory)
            destination = overlay.fetch(name, cache=cache, version=version)
            self.assertEqual(destination, cache / name)
            self.assertEqual(destination.read_bytes(), payload)
            first, fallback = (call.args[0] for call in curl.call_args_list)
            self.assertEqual(first[-1], f'https://raw.githubusercontent.com/chromium/chromium/{version}/{name}')
            self.assertEqual(fallback[-1],
                             f'https://chromium.googlesource.com/chromium/src/+/refs/tags/{version}/{name}?format=TEXT')
            for command in (first, fallback):
                self.assertGreater(int(command[command.index('--max-time') + 1]), 0)
            self.assertNotIn('--retry', first)
            self.assertEqual(fallback[fallback.index('--retry') + 1], '2')
            self.assertGreater(int(fallback[fallback.index('--retry-max-time') + 1]), 0)


if __name__ == '__main__':
    unittest.main()
