#!/usr/bin/env python3
"""Check the assistant UI patch against pinned Chromium and Helium sources."""

import argparse
import hashlib
from pathlib import Path
import tempfile

import apply_breezer_ai_ui as overlay
from check_ai_overlay import prepare


def hashes(tree, paths):
    return {name: hashlib.sha256((tree / name).read_bytes()).hexdigest() for name in paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    paths = overlay.sections()
    with tempfile.TemporaryDirectory(prefix='breezer-ai-ui-check-') as directory:
        tree = Path(directory)
        prepare(tree, offline=args.offline, wanted_paths=paths)
        original = hashes(tree, paths)
        try:
            overlay.apply(tree, check=True)
        except ValueError:
            pass
        else:
            raise AssertionError('Missing overlay unexpectedly passed verification')
        assert hashes(tree, paths) == original
        assert overlay.apply(tree) == len(paths)
        installed = hashes(tree, paths)
        assert overlay.apply(tree, check=True) == 0
        assert overlay.apply(tree) == 0
        assert hashes(tree, paths) == installed
        # A changed target must reject without partially changing other files.
        name = next(iter(paths))
        (tree / name).write_text('unrecognized source\n')
        changed = hashes(tree, paths)
        try:
            overlay.apply(tree)
        except ValueError:
            pass
        else:
            raise AssertionError('Unknown source unexpectedly accepted')
        assert hashes(tree, paths) == changed
    print(f'PASS: assistant UI overlay, {len(paths)} pinned native targets, repeat/check and mismatch retention')


if __name__ == '__main__':
    main()
