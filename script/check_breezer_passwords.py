#!/usr/bin/env python3
"""Check the local password-manager overlay against pinned upstream source."""

import argparse
import hashlib
import importlib.util
import os
import subprocess
import sys
from pathlib import Path
import tempfile

from check_ai_overlay import prepare


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "password_overlay", ROOT / "features/passwords/native-ui/apply.py"
)
overlay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(overlay)


def hashes(tree, paths):
    return {name: hashlib.sha256((tree / name).read_bytes()).hexdigest() for name in paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    paths = overlay.sections()
    with tempfile.TemporaryDirectory(prefix="breezer-passwords-check-") as directory:
        tree = Path(directory)
        evidence = {
            'chrome/browser/password_manager/chrome_password_manager_client.cc',
            'components/password_manager/core/browser/password_form_filling.cc',
            'components/password_manager/core/browser/password_bubble_experiment.cc',
            'chrome/browser/ui/autofill/autofill_context_menu_manager.cc',
        }
        prepare(tree, offline=args.offline, wanted_paths=set(paths) | evidence)
        original = hashes(tree, paths)
        try:
            overlay.apply(tree, check=True)
        except ValueError:
            pass
        else:
            raise AssertionError("Missing password overlay passed verification")
        assert hashes(tree, paths) == original
        assert overlay.apply(tree) == len(paths)
        installed = hashes(tree, paths)
        assert overlay.apply(tree, check=True) == 0
        assert overlay.apply(tree) == 0
        assert hashes(tree, paths) == installed
        subprocess.run([sys.executable, str(ROOT / 'tests/passwords_proactive_test.py'), '-v'],
                       env={**os.environ, 'BREEZER_PASSWORD_SOURCE': str(tree),
                            'PYTHONDONTWRITEBYTECODE': '1'}, check=True)
        name = next(iter(paths))
        (tree / name).write_text("unrecognized source\n")
        drifted = hashes(tree, paths)
        try:
            overlay.apply(tree)
        except ValueError:
            pass
        else:
            raise AssertionError("Drifted password source was accepted")
        assert hashes(tree, paths) == drifted
    print(f"PASS: password manager overlay, {len(paths)} pinned native targets, idempotence and drift retention")


if __name__ == "__main__":
    main()
