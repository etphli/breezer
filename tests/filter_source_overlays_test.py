"""Hermetic exact-source overlay checks. No native/compiler browser runs."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'script'))
import apply_breezer_filter_source_overlays as overlay
import apply_breezer_filter_lists as compiled

FIXTURE = ROOT / 'tests/filter-source-overlays/fixtures/main-port-20261115'
sys.path.insert(0, str(FIXTURE))
import prepare as fixture

MANIFEST = fixture.verify_fixture()
WORK = fixture.prepare()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class FilterOverlays(unittest.TestCase):
    def variant(self):
        folder = Path(tempfile.mkdtemp(prefix='overlay-', dir=WORK / 'controls'))
        shutil.copytree(WORK / 'baseline', folder, dirs_exist_ok=True)
        return folder

    def test_exact_roundtrip_reapplication_and_partial_retry(self):
        folder = self.variant()
        overlay.apply(folder)
        overlay.apply(folder, check=True)
        expected, marker = overlay.expected_files(folder)
        for name, data in expected.items():
            self.assertEqual((WORK / 'source/third_party/ublock' / name).read_bytes(), data)
        overlay.apply(folder)
        self.assertEqual((folder / overlay.MARKER).read_bytes(), marker)
        # An interrupted per-file atomic run may contain both pinned states.
        name = 'js/webext.js'
        (folder / 'third_party/ublock' / name).write_bytes(
            (WORK / 'baseline/third_party/ublock' / name).read_bytes())
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            overlay.apply(folder, check=True)
        overlay.apply(folder)
        overlay.apply(folder, check=True)

    def test_every_drift_rejects_before_any_write(self):
        for row in json.loads((overlay.OVERLAYS / 'manifest.json').read_text())['files']:
            folder = self.variant()
            path = folder / 'third_party/ublock' / row['path']
            path.write_bytes((path.read_bytes() if path.exists() else b'') + b'// drift\n')
            before = {str(p.relative_to(folder)): sha(p) for p in folder.rglob('*') if p.is_file()}
            with self.assertRaisesRegex(ValueError, 'source drift'):
                overlay.apply(folder)
            self.assertEqual(before, {str(p.relative_to(folder)): sha(p) for p in folder.rglob('*') if p.is_file()})

    def test_missing_and_changed_markers_reject(self):
        folder = self.variant()
        with self.assertRaisesRegex(ValueError, 'missing'):
            overlay.apply(folder, check=True)
        overlay.apply(folder)
        (folder / overlay.MARKER).write_text('{}\n')
        with self.assertRaisesRegex(ValueError, 'marker differs'):
            overlay.apply(folder)

    def test_python_and_actual_node_compiler_contracts_agree(self):
        source = WORK / 'source'
        actual = compiled.contract_for(source)
        result = subprocess.run(['node', '--input-type=module', '-e',
            "import {compilerContract} from './script/breezer_filter_lists.mjs';"
            "console.log(JSON.stringify(await compilerContract(process.argv[1])));", str(source)],
            cwd=ROOT, check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(actual, json.loads(result.stdout))
        self.assertEqual(len(actual['sourceHashes']), MANIFEST['candidateCompilerSourceCount'])
        self.assertIn('js/trusted-scriptlet-tokens.js', actual['sourceHashes'])
        self.assertNotIn('js/breezer-binary-binding.js', actual['sourceHashes'])
        self.assertEqual(actual['sourceHashes']['js/storage.js'], sha(source / 'third_party/ublock/js/storage.js'))

    def test_python_rejects_stale_tokens_before_versions_or_inventory(self):
        folder = self.variant()
        overlay.apply(folder)
        path = folder / 'third_party/ublock/js/resources/scriptlets.js'
        path.write_text(path.read_text() + "\nbuiltinScriptlets.push({name:'new-check.js',requiresTrust:true});\n")
        # Missing version would mask the real error if version reads came first.
        (folder / 'chrome/VERSION').rename(folder / 'chrome/VERSION.held')
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            compiled.contract_for(folder)
        self.assertIn(b'stale or modified', caught.exception.stderr)

    def test_fixture_source_license_and_inventory_drift_reject(self):
        for name in ['baseline/third_party/ublock/js/static-net-filtering.js',
                     'LICENSES/GPL-3.0.txt', 'manifest.json']:
            folder = Path(tempfile.mkdtemp(prefix='fixture-drift-', dir=WORK / 'controls'))
            shutil.copytree(FIXTURE, folder, dirs_exist_ok=True)
            path = folder / name
            path.write_bytes(path.read_bytes() + b'\nmodified\n')
            with self.assertRaisesRegex(ValueError, 'pin differs'):
                fixture.verify_fixture(folder)
        folder = Path(tempfile.mkdtemp(prefix='fixture-inventory-', dir=WORK / 'controls'))
        shutil.copytree(FIXTURE, folder, dirs_exist_ok=True)
        (folder / 'baseline/third_party/ublock/js/unpinned.js').write_text('export {};\n')
        with self.assertRaisesRegex(ValueError, 'inventory differs'):
            fixture.verify_fixture(folder)

    def test_source_plan_preserves_compiler_contract_and_refuses_reuse(self):
        source = WORK / 'source'
        output = WORK / 'source-plan'
        command = ['node', str(ROOT / 'script/prepare_breezer_filter_generation_inputs.mjs'),
                   str(source), str(output)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True,
                                check=True, timeout=10)
        self.assertFalse(json.loads(result.stdout)['generationExecuted'])
        contract = json.loads((output / 'contract.json').read_text())
        self.assertEqual(contract, compiled.contract_for(source))
        plan = json.loads((output / 'source-manifest.json').read_text())
        self.assertEqual(plan['compilerSourceCount'], MANIFEST['candidateCompilerSourceCount'])
        self.assertEqual(plan['files']['third_party/ublock/js/trusted-scriptlet-tokens.js']['sha256'],
                         sha(source / 'third_party/ublock/js/trusted-scriptlet-tokens.js'))
        self.assertFalse(plan['generationExecuted'])
        self.assertFalse(plan['nativeValidation'])
        self.assertFalse(plan['performanceAcceptance'])
        self.assertEqual((output / 'producer-binding.js').read_text(),
                         "export const catalogSha256 = '';\n")
        before = {p.name: sha(p) for p in output.iterdir()}
        rejected = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('EEXIST', rejected.stderr)
        self.assertEqual(before, {p.name: sha(p) for p in output.iterdir()})

    def test_source_plan_rejects_stale_tokens_before_output(self):
        folder = self.variant()
        overlay.apply(folder)
        path = folder / 'third_party/ublock/js/resources/scriptlets.js'
        path.write_text(path.read_text() + "\nbuiltinScriptlets.push({name:'plan-stale.js',requiresTrust:true});\n")
        output = WORK / 'rejected-source-plan'
        result = subprocess.run(['node', str(ROOT / 'script/prepare_breezer_filter_generation_inputs.mjs'),
                                 str(folder), str(output)], cwd=ROOT, capture_output=True,
                                text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('stale or modified', result.stderr)
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
