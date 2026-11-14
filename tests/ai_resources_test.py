import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ai_resource_overlay', ROOT / 'script/apply_breezer_ai.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class ResourceBudgetTests(unittest.TestCase):
    def fixture(self, directory, count):
        root = Path(directory) / 'repo'
        source = root / 'features/ai/extension'
        source.mkdir(parents=True)
        (source / 'manifest.json').write_text(json.dumps({'key': overlay.IDENTITY['public_key']}))
        for number in range(count - 1):
            (source / f'module-{number:02}.js').write_text(f'export const value = {number};\n')
        return root, Path(directory) / 'tree'

    def test_extra_stylesheet_and_cache_module_fit(self):
        with tempfile.TemporaryDirectory() as directory:
            root, tree = self.fixture(directory, 52)
            with patch.object(overlay, 'ROOT', root):
                overlay.resources(tree)
            component = tree / 'components/breezer_ai'
            self.assertEqual(len(list(component.glob('*.js'))), 51)
            self.assertIn('"module-50.js"', (component / 'BUILD.gn').read_text())

    def test_resource_overflow_still_rejects(self):
        with tempfile.TemporaryDirectory() as directory:
            root, tree = self.fixture(directory, 65)
            with patch.object(overlay, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, 'reserved GRIT allocation'):
                    overlay.resources(tree)
            self.assertFalse((tree / 'components/breezer_ai/manifest.json').exists())
            self.assertFalse((tree / 'components/breezer_ai').exists())

    def test_full_reservation_fits(self):
        with tempfile.TemporaryDirectory() as directory:
            root, tree = self.fixture(directory, 64)
            with patch.object(overlay, 'ROOT', root):
                overlay.resources(tree)
            component = tree / 'components/breezer_ai'
            self.assertEqual(len(list(component.glob('*.js'))), 63)

    def test_reservation_migration_is_scoped_and_repeatable(self):
        old = '<(SHARED_INTERMEDIATE_DIR)/ash/webui/connectivity_diagnostics/resources/resources.grd'
        template = '''{
  "KEY": {
    "META": {"sizes": {"includes": [50],}},
    "includes": [5960],
  },
  "another/resources.grd": {
    "META": {"sizes": {"includes": [50],}},
    "includes": [5980],
  },
}'''
        for key in [old, overlay.RESOURCE_KEY]:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                tree = Path(directory)
                target = tree / 'tools/gritsettings/resource_ids.spec'
                target.parent.mkdir(parents=True)
                target.write_text(template.replace('KEY', key))
                overlay.reserve_resources(tree)
                expected = template.replace('KEY', overlay.RESOURCE_KEY).replace('[50]', '[64]', 1)
                self.assertEqual(target.read_text(), expected)
                overlay.reserve_resources(tree)
                self.assertEqual(target.read_text(), expected)
                target.write_text(expected.replace('[64]', '[63]', 1))
                with self.assertRaises(ValueError):
                    overlay.reserve_resources(tree)

    def test_changed_reservation_name_rejects(self):
        with tempfile.TemporaryDirectory() as directory:
            tree = Path(directory)
            target = tree / 'tools/gritsettings/resource_ids.spec'
            target.parent.mkdir(parents=True)
            target.write_text('{}')
            with self.assertRaises(ValueError):
                overlay.reserve_resources(tree)


if __name__ == '__main__':
    unittest.main()
