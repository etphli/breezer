#!/usr/bin/env python3
"""Check profile selection, real upstream args composition, and output preservation.

Only temporary fixture directories are written. No Chromium build is required.
"""

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from breezer_build_profile import gn_overrides, output_directory


ROOT = Path(__file__).resolve().parent.parent


def assignments(text):
    return dict(re.findall(r"^\s*(\w+)\s*=\s*([^\n#]+?)\s*(?:#.*)?$", text, re.MULTILINE))


class BuildProfileTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="breezer-build-profile-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.stage = self.root / "stage with spaces"
        (self.stage / "devutils").mkdir(parents=True)
        (self.stage / "helium-chromium").mkdir()
        upstream = ROOT / "upstream/helium-macos"
        for name in ("env.sh", "flags.macos.gn", "devutils/shared.sh", "helium-chromium/flags.gn"):
            shutil.copyfile(upstream / name, self.stage / name)
        self.tree = self.stage / "build/src"
        self.default = self.tree / "out/Default"
        self.default.mkdir(parents=True)
        (self.stage / "build/.breezer-prepared").write_text("fixture marker\n")
        (self.default / "compiled-object").write_bytes(b"existing object\x00\xff")
        (self.default / "args.gn").write_text("existing developer args\n")
        source = (ROOT / "script/build_and_run.sh").read_text()
        selection = 'if [[ -z "${BREEZER_BUILD_PROFILE:-}" ]]; then'
        self.selection = selection + source.split(selection, 1)[1].split('\nif [[ "$(uname -s)"', 1)[0]
        overrides = 'BREEZER_PROFILE_ARGS="'
        self.overrides = overrides + source.split(overrides, 1)[1].split('\nif [[ "$BREEZER_MODE" == --check', 1)[0]
        output = 'source "$_root_dir/devutils/shared.sh"'
        self.output = output + source.split(output, 1)[1].split('\nBREEZER_OMNIBOX_PREPARED=', 1)[0]
        config = 'write_gn_args "$_arch" release'
        self.config = config + source.split(config, 1)[1].split('\ngn_gen\n', 1)[0]

    def run_config(self, extra=None):
        env = {key: value for key, value in os.environ.items()
               if key not in ("BREEZER_BUILD_PROFILE", "BREEZER_DEVELOPMENT_BUILD", "BREEZER_OUT_DIR")}
        env.update(BREEZER_ROOT=str(ROOT), BREEZER_PYTHON=sys.executable, _root_dir=str(self.stage))
        env.update(extra or {})
        shell = "set -euo pipefail\n" + "\n".join((self.selection, self.overrides, self.output, self.config))
        return subprocess.run(["bash", "-c", shell], env=env, capture_output=True, text=True)

    def test_upstream_and_legacy_development_remain_compatible(self):
        for env, official, pgo in (({}, "true", "2"), ({"BREEZER_DEVELOPMENT_BUILD": "1"}, "false", "0"),
                                   ({"BREEZER_BUILD_PROFILE": "development"}, "false", "0")):
            with self.subTest(env=env):
                result = self.run_config(env)
                self.assertEqual(result.returncode, 0, result.stderr)
                args = assignments((self.default / "args.gn").read_text())
                self.assertEqual(args["is_official_build"], official)
                self.assertEqual(args["chrome_pgo_phase"], pgo)
                self.assertNotIn("dcheck_always_on", args)
        self.assertEqual((self.default / "compiled-object").read_bytes(), b"existing object\x00\xff")

    def test_performance_is_separate_and_only_changes_the_intended_args(self):
        before = {path.name: path.read_bytes() for path in self.default.iterdir()}
        result = self.run_config({"BREEZER_BUILD_PROFILE": "release-performance"})
        self.assertEqual(result.returncode, 0, result.stderr)
        performance = self.tree / "out/ReleasePerformance"
        actual = assignments((performance / "args.gn").read_text())
        self.assertEqual({key: actual[key] for key in assignments(gn_overrides("release-performance"))}, {
            "is_official_build": "false", "chrome_pgo_phase": "0", "symbol_level": "0",
            "enable_precompiled_headers": "false", "is_debug": "false",
            "dcheck_always_on": "false", "enable_expensive_dchecks": "false",
        })
        upstream = assignments((self.stage / "helium-chromium/flags.gn").read_text()
                               + (self.stage / "flags.macos.gn").read_text())
        upstream.update(target_cpu='"arm64"' if os.uname().machine == "arm64" else '"x64"', chrome_pgo_phase="2")
        changed = {key for key in upstream.keys() | actual.keys() if upstream.get(key) != actual.get(key)}
        self.assertEqual(changed - {"cc_wrapper"}, {
            "is_official_build", "chrome_pgo_phase", "symbol_level", "enable_precompiled_headers",
            "dcheck_always_on", "enable_expensive_dchecks",
        })
        self.assertEqual({path.name: path.read_bytes() for path in self.default.iterdir()}, before)

    def test_custom_output_after_upstream_env_is_respected(self):
        result = self.run_config({"BREEZER_BUILD_PROFILE": "release-performance", "BREEZER_OUT_DIR": "out/Perf with spaces"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.tree / "out/Perf with spaces/args.gn").is_file())
        self.assertFalse((self.tree / "out/ReleasePerformance").exists())
        self.assertEqual((self.default / "args.gn").read_text(), "existing developer args\n")

    def test_independent_copy_of_default_can_be_reconfigured_without_removing_objects(self):
        performance = self.tree / "out/ReleasePerformance"
        shutil.copytree(self.default, performance)
        result = self.run_config({"BREEZER_BUILD_PROFILE": "release-performance"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(assignments((performance / "args.gn").read_text())["dcheck_always_on"], "false")
        self.assertEqual((performance / "compiled-object").read_bytes(), b"existing object\x00\xff")
        self.assertEqual((self.default / "args.gn").read_text(), "existing developer args\n")

    def test_refuses_default_alias_escape_invalid_profile_and_conflicting_legacy_flag(self):
        alias = self.tree / "out/default-alias"
        alias.symlink_to(self.default, target_is_directory=True)
        for extra in ({"BREEZER_OUT_DIR": "out/Default"}, {"BREEZER_OUT_DIR": str(self.default)},
                      {"BREEZER_OUT_DIR": "out/other/../Default"}, {"BREEZER_OUT_DIR": "out/default-alias"},
                      {"BREEZER_OUT_DIR": "out/Default/Performance"}, {"BREEZER_OUT_DIR": "out/default-alias/Performance"},
                      {"BREEZER_OUT_DIR": "out"}, {"BREEZER_OUT_DIR": "../elsewhere"},
                      {"BREEZER_BUILD_PROFILE": "typo"}, {"BREEZER_DEVELOPMENT_BUILD": "1"}):
            with self.subTest(extra=extra):
                result = self.run_config({"BREEZER_BUILD_PROFILE": "release-performance", **extra})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((self.default / "args.gn").read_text(), "existing developer args\n")

    def test_missing_preparation_marker_preserves_all_outputs(self):
        (self.stage / "build/.breezer-prepared").unlink()
        result = self.run_config({"BREEZER_BUILD_PROFILE": "release-performance"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Existing output is preserved", result.stderr)
        self.assertFalse((self.tree / "out/ReleasePerformance").exists())
        self.assertEqual((self.default / "compiled-object").read_bytes(), b"existing object\x00\xff")

    def test_cli_only_prints_configuration_and_paths(self):
        helper = ROOT / "script/breezer_build_profile.py"
        result = subprocess.run([sys.executable, str(helper), "--profile", "release-performance"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, gn_overrides("release-performance"))
        nonexistent = self.root / "not prepared"
        expected = output_directory(nonexistent, "release-performance")
        result = subprocess.run([sys.executable, str(helper), "--profile", "release-performance", "--source-dir", str(nonexistent)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(expected))
        self.assertFalse(nonexistent.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
