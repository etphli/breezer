#!/usr/bin/env python3
"""Check exact preparation hashing and safe historical extension reconstruction."""

import hashlib
from pathlib import Path
import shutil
import os
import subprocess
import sys
import tempfile
import unittest

from breezer_preparation import ai_source_id, preparation_id, check_extension_refresh


BASE_ID = "a" * 64


def legacy_source_id(root):
    # Keep this algorithm identical to the original build_and_run.sh heredoc.
    files = [root / "script/apply_breezer_ai.py"]
    for directory in ("features/ai/extension", "features/ai/integration"):
        files.extend(path for path in (root / directory).rglob("*") if path.is_file())
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(path.relative_to(root).as_posix().encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


class PreparationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, data in (
            ("script/apply_breezer_ai.py", b"overlay input\n"),
            ("features/ai/integration/identity.json", b'{"identity":"native"}\n'),
            ("features/ai/integration/native-host-manifest.json", b"native manifest\n"),
            ("features/ai/extension/panel.js", b"old panel\n"),
            ("features/ai/extension/panel.css", b"old style\n"),
            ("features/ai/extension/nested.js", b"path-component ordering input\n"),
            ("features/ai/extension/nested/BUILD.gn", b"tracked nested build input\n"),
            ("features/ai/extension/.hidden", b"included hidden input\x00\xff"),
        ):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.extension = self.root / "features/ai/extension"
        self.prepared = self.root / "prepared-extension"
        shutil.copytree(self.extension, self.prepared)
        (self.prepared / "BUILD.gn").write_text("generated resource map\n")
        old_ai_id = legacy_source_id(self.root)
        self.old_marker = hashlib.sha256(f"{BASE_ID}\n{old_ai_id}\n".encode()).hexdigest()

    def test_matches_legacy_source_and_outer_hash_byte_for_byte(self):
        self.assertEqual(ai_source_id(self.root), legacy_source_id(self.root))
        self.assertEqual(preparation_id(BASE_ID, self.root), self.old_marker)
        self.assertEqual(preparation_id(BASE_ID, self.root, self.prepared), self.old_marker)

    def test_extension_only_changes_reconstruct_previous_marker(self):
        (self.extension / "panel.js").write_text("new panel\n")
        (self.extension / "panel.css").write_text("new style\n")
        self.assertNotEqual(preparation_id(BASE_ID, self.root), self.old_marker)
        self.assertEqual(preparation_id(BASE_ID, self.root, self.prepared), self.old_marker)

    def test_native_overlay_integration_and_base_changes_prevent_match(self):
        for name in ("script/apply_breezer_ai.py", "features/ai/integration/identity.json",
                     "features/ai/integration/native-host-manifest.json"):
            path = self.root / name
            original = path.read_bytes()
            with self.subTest(name=name):
                path.write_bytes(original + b"changed")
                self.assertNotEqual(preparation_id(BASE_ID, self.root, self.prepared), self.old_marker)
                path.write_bytes(original)
        self.assertNotEqual(preparation_id("b" * 64, self.root, self.prepared), self.old_marker)

    def test_ignores_only_prepared_top_level_generated_build_file(self):
        (self.prepared / "BUILD.gn").write_text("a different generated file\n")
        self.assertEqual(preparation_id(BASE_ID, self.root, self.prepared), self.old_marker)
        (self.prepared / "nested/BUILD.gn").write_text("changed nested input\n")
        self.assertNotEqual(preparation_id(BASE_ID, self.root, self.prepared), self.old_marker)
        (self.extension / "BUILD.gn").write_text("tracked source build file\n")
        self.assertEqual(ai_source_id(self.root), legacy_source_id(self.root))

    def test_historical_file_set_is_preserved_across_source_addition_or_removal(self):
        (self.extension / "panel.js").unlink()
        (self.extension / "new.js").write_text("new source\n")
        self.assertEqual(preparation_id(BASE_ID, self.root, self.prepared), self.old_marker)
        self.assertNotEqual(preparation_id(BASE_ID, self.root), self.old_marker)
        # Historical reconstruction proves native inputs, not that a resource map
        # can accept removals. The build wrapper must check that separately.

    def test_refresh_allows_additions_but_refuses_removed_resources(self):
        check_extension_refresh(self.prepared, self.root)
        (self.extension / "new.js").write_text("new source\n")
        check_extension_refresh(self.prepared, self.root)
        (self.extension / "panel.js").unlink()
        with self.assertRaisesRegex(ValueError, "removed"):
            check_extension_refresh(self.prepared, self.root)

    def test_refuses_missing_empty_and_file_in_place_of_prepared_directory(self):
        empty = self.root / "empty"
        empty.mkdir()
        generated_only = self.root / "generated-only"
        generated_only.mkdir()
        (generated_only / "BUILD.gn").write_text("generated\n")
        for path in (self.root / "missing", empty, generated_only, self.prepared / "panel.js"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                preparation_id(BASE_ID, self.root, path)

    def test_refuses_symlinked_tree_file_directory_and_generated_file(self):
        linked = self.root / "linked"
        linked.symlink_to(self.prepared, target_is_directory=True)
        with self.assertRaises(ValueError):
            preparation_id(BASE_ID, self.root, linked)
        for name, target in (("linked.js", self.extension / "panel.js"), ("linked-directory", self.extension),
                             ("BUILD.gn", self.extension / "panel.js")):
            path = self.prepared / name
            if path.exists():
                path.unlink()
            path.symlink_to(target)
            with self.subTest(name=name), self.assertRaises(ValueError):
                preparation_id(BASE_ID, self.root, self.prepared)
            path.unlink()

    def test_refuses_symlinked_overlay_and_integration(self):
        overlay = self.root / "script/apply_breezer_ai.py"
        overlay.unlink()
        overlay.symlink_to(self.extension / "panel.js")
        with self.assertRaises(ValueError):
            preparation_id(BASE_ID, self.root, self.prepared)
        overlay.unlink()
        overlay.write_text("overlay input\n")
        (self.root / "features/ai/integration/link").symlink_to(self.extension / "panel.js")
        with self.assertRaises(ValueError):
            preparation_id(BASE_ID, self.root, self.prepared)

    def test_refuses_non_sha256_base_ids(self):
        for base_id in ("", "a" * 63, "A" * 64, "a" * 64 + "\n", "g" * 64):
            with self.subTest(base_id=base_id), self.assertRaises(ValueError):
                preparation_id(base_id, self.root)


class NativeOverlayHookTests(unittest.TestCase):
    def test_first_apply_reuse_mismatch_and_failed_check_preserve_output(self):
        source = (Path(__file__).parent / 'build_and_run.sh').read_text()
        preflight = 'BREEZER_WORKSPACE_ID=' + source.split('BREEZER_WORKSPACE_ID=', 1)[1].split('BREEZER_SOURCE_TREE=', 1)[0]
        hooks = source.split('mv "$BREEZER_OMNIBOX_PREPARED.tmp" "$BREEZER_OMNIBOX_PREPARED"\n', 1)[1].split('write_gn_args ', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / 'script'
            scripts.mkdir()
            tree = root / 'src'
            (tree / 'out').mkdir(parents=True)
            sentinel = tree / 'out/compiled-object'
            sentinel.write_bytes(b'precious compiled output')
            fake = '''import os,sys
from pathlib import Path
if '--fingerprint' in sys.argv:
 letter = 'c' if 'passwords' in Path(__file__).parts else 'b' if Path(__file__).stem == 'apply_breezer_ai_ui' else 'a'
 print(letter*64);sys.exit(0)
tree=Path(sys.argv[-1])
with (tree/'calls').open('a') as out:out.write(Path(__file__).stem+(' check\\n' if '--check' in sys.argv else ' apply\\n'))
if '--check' in sys.argv and os.environ.get('FAIL_CHECK'):sys.exit(1)
'''
            for name in ('workspace', 'ai_ui'):
                (scripts / f'apply_breezer_{name}.py').write_text(fake)
            password_script = root / 'features/passwords/native-ui/apply.py'
            password_script.parent.mkdir(parents=True)
            password_script.write_text(fake)
            env = {**os.environ, 'BREEZER_ROOT': str(root), 'BREEZER_PYTHON': sys.executable,
                   '_src_dir': str(tree), 'BREEZER_STAGE': str(root)}
            shell = 'set -euo pipefail\n' + preflight + '\nprintf refreshed >> "$_src_dir/refresh"\n' + hooks
            def run(extra=None):
                return subprocess.run(['bash', '-c', shell], env={**env, **(extra or {})}, capture_output=True)
            self.assertEqual(run().returncode, 0)
            fingerprints = {'workspace': 'a' * 64, 'ai-ui': 'b' * 64, 'passwords': 'c' * 64}
            for name, fingerprint in fingerprints.items():
                self.assertEqual((tree / f'.breezer-{name}-prepared').read_text().strip(), fingerprint)
            self.assertEqual((tree / 'calls').read_text().count(' apply'), 3)
            self.assertEqual(run().returncode, 0)
            self.assertEqual((tree / 'calls').read_text().count(' apply'), 3)
            previous_refresh = (tree / 'refresh').read_bytes()
            for name, fingerprint in fingerprints.items():
                mismatched = tree / f'.breezer-{name}-prepared'
                mismatched.write_text('z' * 64)
                self.assertNotEqual(run().returncode, 0)
                self.assertEqual((tree / 'refresh').read_bytes(), previous_refresh)
                self.assertEqual(mismatched.read_text(), 'z' * 64)
                mismatched.write_text(fingerprint + '\n')
            marker = tree / '.breezer-workspace-prepared'
            marker.write_text('b' * 64)
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual((tree / 'refresh').read_bytes(), previous_refresh)
            self.assertEqual(marker.read_text(), 'b' * 64)
            marker.write_text('a' * 64 + '\n')
            self.assertNotEqual(run({'FAIL_CHECK': '1'}).returncode, 0)
            self.assertEqual(marker.read_text(), 'a' * 64 + '\n')
            marker.unlink()
            self.assertNotEqual(run({'FAIL_CHECK': '1'}).returncode, 0)
            self.assertFalse(marker.exists())
            self.assertEqual(sentinel.read_bytes(), b'precious compiled output')


if __name__ == "__main__":
    unittest.main(verbosity=2)
