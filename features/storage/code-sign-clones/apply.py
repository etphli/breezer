#!/usr/bin/env python3
"""Apply the pinned signature-clone ownership overlay without discarding caches."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

FOLDER = Path(__file__).resolve().parent
TARGET_HEADER = 'chrome/browser/mac/breezer_clone_session.h'


def fingerprint():
    value = hashlib.sha256()
    for name in ['apply.py', 'clone_session.h', 'code-sign-clones.patch', 'upstream.json']:
        value.update(name.encode() + b'\0')
        value.update(hashlib.sha256((FOLDER / name).read_bytes()).digest())
    return value.hexdigest()


def target(tree, name):
    path = tree / name
    if not path.parent.is_dir() or any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError(f'Unsafe overlay target: {name}')
    return path


def apply(tree, check=False):
    tree = Path(tree).resolve()
    pinned = json.loads((FOLDER / 'upstream.json').read_text())['source_sha256']
    observed = {name: target(tree, name).read_bytes() for name in pinned}
    header = target(tree, TARGET_HEADER)
    expected_header = (FOLDER / 'clone_session.h').read_bytes()
    if header.exists() and header.read_bytes() != expected_header:
        raise ValueError('Clone ownership header has unrecognized changes; preserve the source tree')
    with tempfile.TemporaryDirectory(prefix='breezer-clone-overlay-') as directory:
        pristine = Path(directory) / 'pristine'
        for name, content in observed.items():
            path = pristine / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        command = ['patch', '--batch', '--fuzz=0', '-p1', '-d', str(pristine)]
        sections = re.split(r'(?=^--- a/)', (FOLDER / 'code-sign-clones.patch').read_text(), flags=re.MULTILINE)
        sections = [section for section in sections if section]
        if len(sections) != len(pinned):
            raise ValueError('Unexpected overlay patch targets')
        for name, section in zip(pinned, sections):
            if not section.startswith(f'--- a/{name}\n+++ b/{name}\n'):
                raise ValueError('Unexpected overlay patch target')
            forward = subprocess.run(command + ['-N', '--dry-run'], input=section, text=True, capture_output=True)
            reverse = subprocess.run(command + ['-R', '-f', '--dry-run'], input=section, text=True, capture_output=True)
            if forward.returncode == 0 and reverse.returncode != 0:
                if hashlib.sha256(observed[name]).hexdigest() != pinned[name]:
                    raise ValueError('Pinned clone-manager source drifted; no files changed')
                if check:
                    raise ValueError('Signature-clone ownership overlay is missing')
            elif reverse.returncode == 0 and forward.returncode != 0:
                subprocess.run(command + ['-R', '-f'], input=section, text=True, capture_output=True, check=True)
                if hashlib.sha256((pristine / name).read_bytes()).hexdigest() != pinned[name]:
                    raise ValueError('Applied clone-manager source drifted; no files changed')
            else:
                raise ValueError('Unrecognized signature-clone source; no files changed')
            subprocess.run(command + ['-N'], input=section, text=True, capture_output=True, check=True)
        desired = {name: (pristine / name).read_bytes() for name in pinned}
        desired[TARGET_HEADER] = expected_header
        originals = {**observed, TARGET_HEADER: header.read_bytes() if header.exists() else None}
        if check and any(originals[name] != data for name, data in desired.items()):
            raise ValueError('Signature-clone ownership overlay is incomplete')
        for name, original in originals.items():
            path = target(tree, name)
            if (path.read_bytes() if path.exists() else None) != original:
                raise ValueError('Source changed during overlay preparation')
        changed = 0
        for name, content in desired.items():
            if originals[name] == content:
                continue
            path = target(tree, name)
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.breezer-clone-', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(content)
            try:
                if path.exists():
                    shutil.copymode(path, temporary)
                else:
                    temporary.chmod(0o644)
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
            changed += 1
        return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_tree', nargs='?', type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--fingerprint', action='store_true')
    args = parser.parse_args()
    try:
        if args.fingerprint:
            if args.source_tree or args.check:
                parser.error('--fingerprint does not accept a source tree or --check')
            print(fingerprint())
        elif args.source_tree:
            print(f'Signature-clone overlay verified; {apply(args.source_tree, args.check)} files updated.')
        else:
            parser.error('Provide a prepared Chromium source tree')
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Cannot prepare signature-clone cleanup: {error}\n')


if __name__ == '__main__':
    main()
