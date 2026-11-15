"""Exercise the real workspace transformer and both native platform branches."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'script'))
import apply_breezer_workspace as workspace

TARGET = 'chrome/browser/ui/ui_features.cc'
BEFORE = b'BASE_FEATURE(kTabHoverCardImages, base::FEATURE_ENABLED_BY_DEFAULT);\n'
NEIGHBOR = b'BASE_FEATURE(kOtherFeature, base::FEATURE_DISABLED_BY_DEFAULT);\n'


class MacHoverCardDefaultTest(unittest.TestCase):
    def test_overlay_preserves_neighbors_and_is_idempotent(self):
        result = workspace.transform(TARGET, NEIGHBOR + BEFORE + NEIGHBOR)
        self.assertTrue(result.startswith(NEIGHBOR) and result.endswith(NEIGHBOR))
        self.assertEqual(workspace.transform(TARGET, result), result)

    def test_missing_and_duplicate_anchors_fail(self):
        for source in [NEIGHBOR, BEFORE + BEFORE]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                workspace.transform(TARGET, source)

    def test_mixed_original_and_applied_states_fail(self):
        applied = workspace.transform(TARGET, BEFORE)
        for source in [BEFORE + applied, applied + BEFORE,
                       b'#if 1\n' + BEFORE + b'#else\n' + applied + b'#endif\n',
                       applied + applied,
                       applied.replace(b'IS_MAC', b'IS_WIN')]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                workspace.transform(TARGET, source)

    def test_apply_and_check_reject_mixed_state_before_any_write(self):
        choices = workspace.replacements()[TARGET]
        applied = workspace.transform(TARGET, BEFORE)
        with tempfile.TemporaryDirectory(prefix='breezer-hover-prepare-') as directory:
            tree = Path(directory)
            target = tree / TARGET
            target.parent.mkdir(parents=True)
            target.write_bytes(BEFORE + applied)
            pending = tree / 'other.cc'
            pending.write_bytes(b'old\n')
            replacements = {TARGET: choices, 'other.cc': [('old\n', 'new\n')]}
            with patch.object(workspace, 'replacements', return_value=replacements), \
                    patch.object(workspace, 'added_files', return_value={}):
                for check in [False, True]:
                    with self.subTest(check=check), self.assertRaises(ValueError):
                        workspace.apply(tree, check=check)
                    self.assertEqual(target.read_bytes(), BEFORE + applied)
                    self.assertEqual(pending.read_bytes(), b'old\n')

    @unittest.skipUnless(shutil.which('clang++'), 'Clang required for platform-branch verification')
    def test_compiled_platform_defaults(self):
        feature = workspace.transform(TARGET, BEFORE).decode()
        preamble = ('#define BUILDFLAG(flag) flag\n'
                    '#define BASE_FEATURE(name, state) constexpr bool name = state\n'
                    'namespace base { constexpr bool FEATURE_ENABLED_BY_DEFAULT = true; '
                    'constexpr bool FEATURE_DISABLED_BY_DEFAULT = false; }\n')
        with tempfile.TemporaryDirectory(prefix='breezer-hover-default-') as directory:
            for mac, expected in [(1, 'false'), (0, 'true')]:
                with self.subTest(mac=mac):
                    path = Path(directory) / f'platform-{mac}.cc'
                    path.write_text(preamble + feature +
                                    f'static_assert(kTabHoverCardImages == {expected});\n')
                    subprocess.run(['clang++', '-std=c++20', '-fsyntax-only',
                                    f'-DIS_MAC={mac}', str(path)],
                                   capture_output=True, check=True, timeout=15)


if __name__ == '__main__':
    unittest.main()
