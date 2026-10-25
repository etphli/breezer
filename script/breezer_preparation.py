#!/usr/bin/env python3
"""Reconstruct Breezer's preparation marker without changing build files.

With --prepared-extension, use the saved extension tree's historical file set,
excluding only its top-level generated BUILD.gn. Native integration and overlay
inputs always come from this checkout. A matching old marker proves those native
inputs and the supplied base ID match. The caller must separately decide whether
extension additions or removals can be applied to its prepared resource map.
The CLI refuses removed extension files because the overlay copies resources
without deleting old files.
"""

import argparse
import hashlib
from pathlib import Path
import re
import stat


ROOT = Path(__file__).resolve().parent.parent


def tree_files(directory, logical_directory, prepared=False):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError(f"Expected a real source directory: {directory}")
    files = []
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Source trees must not contain symlinks: {path}")
        mode = path.stat().st_mode
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise ValueError(f"Source trees must contain only regular files and directories: {path}")
        relative = path.relative_to(directory)
        if prepared and relative.as_posix() == "BUILD.gn":
            continue
        files.append(((Path(logical_directory) / relative).as_posix(), path))
    if not files:
        raise ValueError(f"The source directory contains no input files: {directory}")
    return files


def ai_source_id(root=ROOT, prepared_extension=None):
    root = Path(root)
    overlay = root / "script/apply_breezer_ai.py"
    if overlay.is_symlink() or not overlay.is_file():
        raise ValueError(f"Expected the real AI overlay script: {overlay}")
    files = [("script/apply_breezer_ai.py", overlay)]
    extension = root / "features/ai/extension" if prepared_extension is None else Path(prepared_extension)
    files.extend(tree_files(extension, "features/ai/extension", prepared=prepared_extension is not None))
    files.extend(tree_files(root / "features/ai/integration", "features/ai/integration"))
    digest = hashlib.sha256()
    for logical_name, path in sorted(files, key=lambda entry: Path(entry[0])):
        digest.update(logical_name.encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def preparation_id(base_id, root=ROOT, prepared_extension=None):
    if not re.fullmatch(r"[0-9a-f]{64}", base_id):
        raise ValueError("The base ID must be a complete lowercase SHA-256 digest.")
    source_id = ai_source_id(root, prepared_extension)
    return hashlib.sha256(f"{base_id}\n{source_id}\n".encode()).hexdigest()


def check_extension_refresh(prepared_extension, root=ROOT):
    previous = {name for name, _ in tree_files(Path(prepared_extension), "features/ai/extension", prepared=True)}
    current = {name for name, _ in tree_files(Path(root) / "features/ai/extension", "features/ai/extension")}
    if previous - current:
        raise ValueError("Extension resources were removed; use a separate build directory.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-id", required=True, help="Current base preparation SHA-256")
    parser.add_argument("--prepared-extension", type=Path, help="Previously prepared extension directory")
    args = parser.parse_args()
    try:
        if args.prepared_extension is not None:
            check_extension_refresh(args.prepared_extension)
        print(preparation_id(args.base_id, prepared_extension=args.prepared_extension))
    except (OSError, ValueError) as error:
        parser.exit(1, f"Cannot reconstruct Breezer preparation: {error}\n")


if __name__ == "__main__":
    main()
