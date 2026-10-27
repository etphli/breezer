#!/usr/bin/env python3
"""Apply or verify Breezer's full-height assistant UI on prepared Chromium source.

Run after Helium patches, Breezer branding, and the AI overlay, before GN.
This script neither owns preparation markers nor removes previous overlays.
"""

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent
PATCH = ROOT / "features/ai/native-ui/sidebar.patch"
INPUTS = (
    "script/apply_breezer_ai_ui.py",
    "features/ai/native-ui/sidebar.patch",
)


def fingerprint():
    digest = hashlib.sha256()
    for name in sorted(INPUTS):
        digest.update(name.encode() + b"\0")
        digest.update(hashlib.sha256((ROOT / name).read_bytes()).digest())
    return digest.hexdigest()


def sections():
    result = {}
    for section in re.split(r"(?=^--- a/)", PATCH.read_text(), flags=re.MULTILINE):
        if not section:
            continue
        match = re.match(r"--- a/(\S+)\n\+\+\+ b/(\S+)\n@@ ", section)
        if not match or match[1] != match[2]:
            raise ValueError("Overlay must modify existing files without renames")
        name = match[1]
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or str(path) != name:
            raise ValueError(f"Invalid overlay path: {name}")
        if name in result:
            raise ValueError(f"Duplicate overlay path: {name}")
        result[name] = section
    if not result:
        raise ValueError("Overlay contains no file changes")
    return result


def patch(tree, section, reverse=False, dry_run=False):
    # -N prevents patch from guessing that an already-applied patch is reversed.
    command = ["patch", "--batch", "--fuzz=0", "-p1", "-d", str(tree)]
    command += ["-R", "-f"] if reverse else ["-N"]
    if dry_run:
        command.append("--dry-run")
    return subprocess.run(command, input=section, text=True, capture_output=True)


def source_file(tree, name):
    path = tree / name
    if any(parent.is_symlink() for parent in [path, *path.parents]):
        raise ValueError(f"Overlay target must not use symlinks: {name}")
    if not path.is_file():
        raise ValueError(f"Missing prepared source file: {name}")
    return path


def apply(tree, check=False):
    tree = Path(tree).resolve()
    changes = sections()
    originals = {name: source_file(tree, name).read_bytes() for name in changes}
    replacements = {}
    with tempfile.TemporaryDirectory(prefix="breezer-ai-ui-") as directory:
        staged = Path(directory)
        for name, content in originals.items():
            destination = staged / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        for name, section in changes.items():
            forward = patch(staged, section, dry_run=True)
            reverse = patch(staged, section, reverse=True, dry_run=True)
            if forward.returncode == 0 and reverse.returncode != 0:
                if check:
                    raise ValueError(f"Assistant UI overlay is missing from {name}")
                result = patch(staged, section)
                if result.returncode:
                    raise ValueError(f"Cannot stage {name}: {result.stdout}{result.stderr}")
                replacements[name] = (staged / name).read_bytes()
            elif reverse.returncode == 0 and forward.returncode != 0:
                continue
            else:
                raise ValueError(f"Unrecognized or ambiguous source in {name}; use a freshly prepared tree.\n"
                                 f"{forward.stdout}{forward.stderr}")
        # Validate every target before changing any real file. File-level atomic
        # replacement allows a retry after an interrupted multi-file update.
        for name, original in originals.items():
            if source_file(tree, name).read_bytes() != original:
                raise ValueError(f"Source changed during preparation: {name}")
        for name, content in replacements.items():
            target = tree / name
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".breezer-ai-ui-", delete=False) as output:
                temporary = Path(output.name)
                output.write(content)
            try:
                shutil.copymode(target, temporary)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
    return len(replacements)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_tree", nargs="?", type=Path)
    parser.add_argument("--check", action="store_true", help="Verify installed changes without writing")
    parser.add_argument("--fingerprint", action="store_true", help="Print the separate overlay input SHA-256")
    args = parser.parse_args()
    try:
        if args.fingerprint:
            if args.source_tree is not None or args.check:
                parser.error("--fingerprint does not take a source tree or --check")
            print(fingerprint())
            return
        if args.source_tree is None:
            parser.error("Provide the prepared Chromium source tree")
        changed = apply(args.source_tree, check=args.check)
        print(f"Breezer ai-ui overlay verified; {changed} files updated.")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Cannot prepare Breezer ai-ui: {error}\n")


if __name__ == "__main__":
    main()
