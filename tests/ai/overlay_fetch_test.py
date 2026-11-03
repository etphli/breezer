"""Interrupted fixture downloads never become reusable cache entries."""
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
    def test_failed_download_is_not_reused_and_retry_publishes_complete_bytes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(overlay, 'CACHE', Path(directory)):
            destination = Path(directory) / 'source/file.cc'
            calls = []

            def download(command, **kwargs):
                target = Path(command[command.index('--output') + 1])
                calls.append(target)
                target.write_bytes(b'partial' if len(calls) == 1 else b'complete pinned fixture')
                if len(calls) == 1:
                    raise subprocess.CalledProcessError(18, command)

            with patch.object(overlay.subprocess, 'run', side_effect=download):
                with self.assertRaises(subprocess.CalledProcessError):
                    overlay.fetch('source/file.cc')
                self.assertFalse(destination.exists())
                self.assertEqual(list(destination.parent.iterdir()), [])
                self.assertEqual(overlay.fetch('source/file.cc'), destination)
                self.assertEqual(destination.read_bytes(), b'complete pinned fixture')
                self.assertEqual(overlay.fetch('source/file.cc'), destination)
                self.assertEqual(len(calls), 2)
                self.assertEqual(list(destination.parent.iterdir()), [destination])


if __name__ == '__main__':
    unittest.main()
