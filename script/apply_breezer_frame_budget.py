#!/usr/bin/env python3
"""Prepare the disabled native experiment in a private, quiescent source copy.

No concurrent writers/readers or power-loss durability guarantee. Unknown inputs
and stale markers require a separately reviewed copy, never cache deletion.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

ROOT = Path(__file__).resolve().parent.parent
DATA = Path('features/performance/frame-budget')
MARKER = '.breezer-frame-budget-prepared'
PREPARING = '.breezer-frame-budget-preparing'
NAMES = tuple('components/viz/client/' + name for name in (
    'frame_eviction_manager.cc', 'frame_eviction_manager.h',
    'frame_eviction_manager_unittest.cc'))
INPUTS = ('script/apply_breezer_frame_budget.py', str(DATA / 'pins.json'),
          *(str(DATA / 'payload' / name) for name in NAMES))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def real_path(path):
    path = Path(os.path.abspath(path))
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ValueError('symlink in path: ' + str(path))
    return path


def regular(path):
    path = real_path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('expected independent regular file: ' + str(path))
    return info


def fingerprint():
    result = hashlib.sha256()
    for name in sorted(INPUTS):
        path = ROOT / name
        regular(path)
        result.update(name.encode() + b'\0')
        result.update(hashlib.sha256(path.read_bytes()).digest())
    return result.hexdigest()


def guard_default(tree):
    tree = Path(tree).resolve()
    if any(os.path.lexists(tree / name) for name in (MARKER, PREPARING)):
        raise ValueError('experimental marker requires explicit opt-in; preserve this source and output')
    pins = json.loads((ROOT / DATA / 'pins.json').read_text())
    if pins['schema'] != 1 or set(pins['source_files']) != set(NAMES):
        raise ValueError('unexpected pin contract')
    for name in NAMES:
        contract = pins['source_files'][name]
        if contract['before_sha256'] == contract['after_sha256']:
            continue
        path = tree / name
        if not os.path.lexists(path):
            continue
        regular(path)
        if digest(path.read_bytes()) == contract['after_sha256']:
            raise ValueError('unmarked frame-budget source requires explicit recovery: ' + name)


def inspect(tree):
    tree = real_path(tree)
    if not tree.is_dir():
        raise ValueError('expected existing source directory')
    pins = json.loads((ROOT / DATA / 'pins.json').read_text())
    if pins['schema'] != 1 or set(pins['source_files']) != set(NAMES):
        raise ValueError('unexpected pin contract')
    identity = fingerprint()
    marker = tree / MARKER
    marked = os.path.lexists(marker)
    intent = tree / PREPARING
    preparing = os.path.lexists(intent)
    for path, present in ((marker, marked), (intent, preparing)):
        if present:
            regular(path)
            if path.read_bytes() != (identity + '\n').encode():
                raise ValueError('frame-budget fingerprint changed; preserve source/out and use a separately reviewed copy')
    pending = []
    for name in NAMES:
        path = tree / name
        info = regular(path)
        current = digest(path.read_bytes())
        payload = (ROOT / DATA / 'payload' / name).read_bytes()
        contract = pins['source_files'][name]
        before, after = contract['before_sha256'], contract['after_sha256']
        if digest(payload) != after:
            raise ValueError('payload hash mismatch: ' + name)
        if current not in (before, after):
            raise ValueError('unknown input: ' + name + ' sha256=' + current)
        if current != after:
            if marked:
                raise ValueError('marked source is not fully applied: ' + name)
            pending.append((path, payload, stat.S_IMODE(info.st_mode)))
    return tree, identity, marked, preparing, pending


def replace(path, payload, mode):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.breezer-',
                                     suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(payload)
            stream.flush()
            os.fchmod(fd, mode)
            os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)
    if path.read_bytes() != payload:
        raise OSError('replacement verification failed: ' + str(path))


def apply(tree, check=False, preflight=False, private=False):
    tree, identity, marked, preparing, pending = inspect(tree)
    if check:
        if pending or not marked or preparing:
            raise ValueError('complete applied source and matching marker required')
        return 0
    if preflight:
        return len(pending)
    if not private:
        raise ValueError('acknowledge --private-quiescent-copy before preparation')
    if marked and not preparing:
        return 0
    if not preparing:
        replace(tree / PREPARING, (identity + '\n').encode(), 0o600)
    for path, payload, mode in pending:
        replace(path, payload, mode)
    # Verify all three hashes again, including the unchanged header, before marker.
    _, verified_identity, _, intent_present, remaining = inspect(tree)
    if remaining or verified_identity != identity or not intent_present:
        raise ValueError('source or overlay changed during preparation')
    if not marked:
        replace(tree / MARKER, (identity + '\n').encode(), 0o600)
    _, final_identity, final_marked, final_preparing, remaining = inspect(tree)
    if remaining or final_identity != identity or not final_marked or not final_preparing:
        raise ValueError('source or overlay changed before preparation completed')
    (tree / PREPARING).unlink()
    return len(pending)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_tree', nargs='?', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--fingerprint', action='store_true')
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--preflight', action='store_true', help='Read-only verification of known resumable inputs')
    mode.add_argument('--guard-default', action='store_true', help='Reject markers and known legacy experimental files without writing')
    parser.add_argument('--private-quiescent-copy', action='store_true')
    args = parser.parse_args()
    try:
        if args.fingerprint:
            if args.source_tree is not None or args.private_quiescent_copy:
                parser.error('--fingerprint takes no source or copy acknowledgement')
            print(fingerprint())
        else:
            if args.source_tree is None:
                parser.error('provide the prepared Chromium source directory')
            if args.guard_default:
                if args.private_quiescent_copy:
                    parser.error('--guard-default takes no copy acknowledgement')
                guard_default(args.source_tree)
                print('No known frame-budget experimental source detected.')
            else:
                count = apply(args.source_tree, args.check, args.preflight, args.private_quiescent_copy)
                print(f'Frame-budget source verified; {count} files pending or updated.')
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f'Cannot prepare Breezer frame budget: {error}\n')


if __name__ == '__main__':
    main()
