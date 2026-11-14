"""Verify and copy the bounded, licensed filter fixture. No downloads or browsers."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / 'script'))
import apply_breezer_filter_source_overlays as overlays

MANIFEST_SHA256 = 'd4d2595e7de12f4d8be0a7929fa7f8a0ee9e2e64e8e1040117ead4861ab7c200'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_fixture(folder=HERE):
    manifest_bytes = (folder / 'manifest.json').read_bytes()
    if digest(manifest_bytes) != MANIFEST_SHA256:
        raise ValueError('Filter fixture manifest pin differs')
    manifest = json.loads(manifest_bytes)
    for name, expected in manifest['upstreamInputs'].items():
        if digest((ROOT / name).read_bytes()) != expected:
            raise ValueError('Filter fixture upstream input pin differs: ' + name)
    if digest((overlays.OVERLAYS / 'manifest.json').read_bytes()) != manifest['overlayManifestSha256']:
        raise ValueError('Filter fixture overlay pin differs')
    for name, row in manifest['files'].items():
        path = folder / name
        if path.is_symlink() or any(p.is_symlink() for p in path.parents):
            raise ValueError('Filter fixture refuses symlinks: ' + name)
        data = path.read_bytes()
        if len(data) != row['bytes'] or digest(data) != row['sha256']:
            raise ValueError('Filter fixture source pin differs: ' + name)
        if not row.get('license') or not row.get('origin'):
            raise ValueError('Filter fixture license/provenance missing: ' + name)
    actual = {p.relative_to(folder).as_posix()
              for subdir in ['baseline', 'headers', 'LICENSES']
              for p in (folder / subdir).rglob('*') if p.is_file()}
    if actual != set(manifest['files']):
        raise ValueError('Filter fixture inventory differs')
    return manifest


def prepare():
    verify_fixture()  # Reject drift before creating output or applying overlays.
    output = ROOT / 'build/main-port-filter'
    output.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='fixture-', dir=output))
    shutil.copytree(HERE / 'baseline', work / 'baseline')
    shutil.copytree(HERE / 'baseline', work / 'source')
    overlays.apply(work / 'source')
    overlays.apply(work / 'source', check=True)
    (work / 'controls').mkdir()
    return work


if __name__ == '__main__':
    if sys.argv[1:] == ['--check']:
        verify_fixture()
        print('Filter fixture pins, licenses and upstream inputs verified.')
    elif not sys.argv[1:]:
        print(prepare())
    else:
        raise SystemExit('prepare.py [--check]')
