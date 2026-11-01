"""Overlay regressions using pinned source; never modify an existing build."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('clone_overlay', ROOT / 'features/storage/code-sign-clones/apply.py')
overlay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(overlay)
SOURCE = os.environ.get('BREEZER_CLONE_SOURCE')
PATHS = ('chrome/browser/mac/code_sign_clone_manager.mm',
         'chrome/browser/mac/code_sign_clone_manager_unittest.mm',
         'chrome/browser/mac/BUILD.gn')


@unittest.skipUnless(SOURCE, 'Set BREEZER_CLONE_SOURCE to the pinned prepared source')
class OverlayTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='breezer-clone-overlay-test-')
        self.addCleanup(self.temp.cleanup)
        self.tree = Path(self.temp.name)
        for name in PATHS:
            path = self.tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(Path(SOURCE) / name, path)
        pinned = json.loads((overlay.FOLDER / 'upstream.json').read_text())['source_sha256']
        sections = [part for part in re.split(r'(?=^--- a/)', (overlay.FOLDER / 'code-sign-clones.patch').read_text(), flags=re.M) if part]
        for name, section in zip(pinned, sections):
            path = self.tree / name
            if hashlib.sha256(path.read_bytes()).hexdigest() != pinned[name]:
                subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-R', '-f', '-d', str(self.tree)],
                               input=section, text=True, capture_output=True, check=True)
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), pinned[name])
        self.originals = {name: (self.tree / name).read_bytes() for name in PATHS}

    def test_apply_check_repeat(self):
        with self.assertRaises(ValueError):
            overlay.apply(self.tree, check=True)
        self.assertEqual(overlay.apply(self.tree), 4)
        self.assertEqual(overlay.apply(self.tree, check=True), 0)
        self.assertEqual(overlay.apply(self.tree), 0)
        self.assertEqual((self.tree / overlay.TARGET_HEADER).read_bytes(),
                         (overlay.FOLDER / 'clone_session.h').read_bytes())

    def test_native_manager_lifecycle_wiring(self):
        overlay.apply(self.tree)
        source = (self.tree / PATHS[0]).read_text()
        self.assertIn('".sessions-v1"', source)
        self.assertIn('(void)session_lease.release();', source)
        self.assertLess(source.index('if (!CloneApp('), source.index('(void)session_lease.release();'))
        self.assertIn('breezer::clone_sessions::Cleanup(clone_root.value(), unique_temp_dir_suffix);', source)
        self.assertIn('unique_temp_dir_path.DirName() == clone_temp_dir', source)
        callback = source.index('std::move(callback).Run(clone_app_path);')
        sweep = source.index('breezer::clone_sessions::Cleanup(unique_temp_dir_path.DirName().value());')
        self.assertLess(callback, sweep)
        self.assertIn('while (getppid() != 1)', source)
        self.assertIn('HardLinkMainExecutable(source_path, destination_path,', source)

    def test_partial_application_recovers(self):
        overlay.apply(self.tree)
        (self.tree / PATHS[1]).write_bytes(self.originals[PATHS[1]])
        (self.tree / overlay.TARGET_HEADER).unlink()
        self.assertEqual(overlay.apply(self.tree), 2)
        self.assertEqual(overlay.apply(self.tree, check=True), 0)

    def test_drift_retains_every_original(self):
        (self.tree / PATHS[1]).write_text('unrecognized source\n')
        before = {name: (self.tree / name).read_bytes() for name in PATHS}
        with self.assertRaises(ValueError):
            overlay.apply(self.tree)
        self.assertEqual(before, {name: (self.tree / name).read_bytes() for name in PATHS})
        self.assertFalse((self.tree / overlay.TARGET_HEADER).exists())

    def test_unknown_header_and_symlink_rejected(self):
        header = self.tree / overlay.TARGET_HEADER
        header.write_text('user changes\n')
        with self.assertRaises(ValueError):
            overlay.apply(self.tree)
        self.assertEqual(header.read_text(), 'user changes\n')
        header.unlink()
        header.symlink_to(self.tree / PATHS[0])
        with self.assertRaises(ValueError):
            overlay.apply(self.tree)


if __name__ == '__main__':
    unittest.main()
