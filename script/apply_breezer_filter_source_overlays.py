#!/usr/bin/env python3
"""Apply exact, repo-owned filter module overlays to a NEW private source copy.

Run before compiler/list/image generation. This does not regenerate any artifact.
Unknown bytes reject before writes; complete or partially applied runs converge.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parent.parent
OVERLAYS = ROOT / 'features/performance/filter-source-overlays'
MARKER = '.breezer-filter-source-overlays'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def replace_file(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.breezer-filter-overlay-', delete=False) as out:
        temporary = Path(out.name)
        out.write(data)
    temporary.replace(path)


def expected_files(tree):
    manifest_bytes = (OVERLAYS / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest['schema'] != 1:
        raise ValueError('Unsupported filter overlay manifest')
    folder = tree / 'third_party/ublock'
    files = {}
    for row in manifest['files']:
        name = row['path']
        if not name.startswith('js/') or '..' in Path(name).parts or name in files:
            raise ValueError('Invalid or duplicate overlay path')
        path = folder / name
        if path.is_symlink() or any(p.is_symlink() for p in path.parents):
            raise ValueError('Filter overlay refuses symlink paths')
        current = path.read_bytes() if path.exists() else None
        current_sha = sha(current) if current is not None else None
        if current_sha == row['afterSha256']:
            data = current
        elif current_sha == row['beforeSha256']:
            if 'payload' in row:
                data = (OVERLAYS / row['payload']).read_bytes()
            else:
                lines = current.decode('utf-8').splitlines(keepends=True)
                for edit in reversed(row['edits']):
                    at = edit['start']
                    if lines[at:at + len(edit['remove'])] != edit['remove']:
                        raise ValueError('Exact filter overlay hunk differs: ' + name)
                    lines[at:at + len(edit['remove'])] = edit['insert']
                data = ''.join(lines).encode('utf-8')
        else:
            raise ValueError('Filter overlay source drift: ' + name)
        if sha(data) != row['afterSha256']:
            raise ValueError('Filter overlay output differs: ' + name)
        files[name] = data
    marker = (json.dumps({'schema': 1, 'manifestSha256': sha(manifest_bytes)},
                         sort_keys=True, separators=(',', ':')) + '\n').encode()
    return files, marker


def apply(tree, check=False):
    tree = Path(tree).resolve()
    files, marker = expected_files(tree)
    marker_path = tree / MARKER
    if marker_path.is_symlink():
        raise ValueError('Filter overlay refuses a symlink marker')
    if marker_path.exists() and marker_path.read_bytes() != marker:
        raise ValueError('Filter overlay marker differs; use a fresh source copy')
    if check:
        if not marker_path.exists() or marker_path.read_bytes() != marker:
            raise ValueError('Filter source overlay marker is missing')
        for name, data in files.items():
            if (tree / 'third_party/ublock' / name).read_bytes() != data:
                raise ValueError('Filter overlay is incomplete: ' + name)
        return
    # Validate every input before any mutation, then replace each file atomically.
    for name, data in files.items():
        path = tree / 'third_party/ublock' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.read_bytes() == data:
            continue
        replace_file(path, data)
    replace_file(marker_path, marker)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_dir', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    apply(args.source_dir, args.check)
    print('Filter source overlays verified.' if args.check else 'Filter source overlays applied; generation still required.')
