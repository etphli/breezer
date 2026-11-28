"""Startup-body staging must leave literal storage bytes unchanged. No browser runs."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'script'))
import apply_breezer_filter_lists as compiled

FIXTURE = ROOT / 'tests/filter-source-overlays/fixtures/main-port-20261115'
sys.path.insert(0, str(FIXTURE))
import prepare as fixture

fixture.verify_fixture()
WORK = fixture.prepare()


def snapshot(folder):
    return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in folder.rglob('*') if p.is_file()}


class StartupBodyStaging(unittest.TestCase):
    def tree(self, storage=None):
        folder = Path(tempfile.mkdtemp(prefix='compiled-lists-', dir=WORK / 'controls'))
        shutil.copytree(WORK / 'source', folder / 'tree')
        tree = folder / 'tree'
        ublock = tree / 'third_party/ublock'
        (ublock / 'BUILD.gn').write_text('inputs = [\n        "generate_file_list.py",\n]\n')
        if storage:
            path = ublock / 'js/storage.js'
            path.write_text(storage(path.read_text()))
        artifacts = folder / 'artifacts'
        artifacts.mkdir()
        contract = compiled.contract_for(tree)
        (artifacts / 'contract.json').write_text(json.dumps(contract))
        payload = b'magic\ncompiled\n'
        sha = hashlib.sha256(payload).hexdigest()
        (artifacts / f'{sha}.txt').write_bytes(payload)
        (artifacts / 'index.json').write_text(json.dumps({
            'schema': 1, 'buildId': compiled.digest(compiled.canonical(contract).encode()),
            'context': {'compiledMagic': 'magic', 'engineVersion': contract['engineVersion'],
                        'engineJavaScriptVersion': contract['engineJavaScriptVersion']},
            'entries': {'ublock-filters': {
                'payloadSha256': sha, 'path': f'{sha}.txt', 'rawBytes': 10,
                'payloadBytes': len(payload), 'trustedSource': True, 'rawSha256': '0' * 64}},
        }))
        return tree, artifacts

    def test_overlaid_startup_body_tree_stages_and_checks_without_rewriting_storage(self):
        tree, artifacts = self.tree()
        storage = (tree / 'third_party/ublock/js/storage.js').read_bytes()
        compiled.apply(tree, artifacts)
        compiled.apply(tree, artifacts, check=True)
        self.assertEqual((tree / 'third_party/ublock/js/storage.js').read_bytes(), storage)

    def test_startup_body_tree_that_would_rewrite_storage_refuses_before_writes(self):
        # Without the overlay hook, staging would change bytes the native contract binds
        # literally, so a later --check could never match.
        for name, change in {
            'unhooked': compiled.unhook,
            'unknown seam': lambda text: compiled.unhook(text).replace(compiled.ANCHOR, '    // changed\n'),
            'moved import': lambda text: text.replace(compiled.IMPORT, '', 1) + compiled.IMPORT,
        }.items():
            with self.subTest(name):
                tree, artifacts = self.tree(change)
                before = snapshot(tree)
                with self.assertRaisesRegex(ValueError, 'apply_breezer_filter_source_overlays'):
                    compiled.apply(tree, artifacts)
                self.assertEqual(snapshot(tree), before)


    def test_crlf_startup_body_storage_is_never_rewritten(self):
        tree, artifacts = self.tree(lambda text: text.replace('\n', '\r\n'))
        path = tree / 'third_party/ublock/js/storage.js'
        self.assertIn(b'\r\n', path.read_bytes())
        before = path.read_bytes()
        try:
            compiled.apply(tree, artifacts)
        except ValueError:
            pass
        self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
