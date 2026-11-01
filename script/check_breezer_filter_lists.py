#!/usr/bin/env python3
"""Exercise the experiment in a small disposable source fixture and real GRIT."""
import argparse
import gzip
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

import apply_breezer_filter_lists as overlay


def check(source, artifacts):
    with tempfile.TemporaryDirectory(prefix='breezer-filter-overlay-') as directory:
        tree = Path(directory).resolve()
        shutil.copytree(source / 'third_party/ublock', tree / 'third_party/ublock')
        for name in ['chrome/VERSION', 'v8/include/v8-version.h', 'ui/webui/resources/tools/generate_grd.py', 'tools/gritsettings/resource_ids.spec']:
            target = tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
        overlay.apply(tree, artifacts)
        overlay.apply(tree, artifacts, check=True)
        first = (tree / '.breezer-filter-lists-prepared').read_bytes()
        overlay.apply(tree, artifacts)
        assert first == (tree / '.breezer-filter-lists-prepared').read_bytes(), 'Idempotence failed'

        folder = tree / 'third_party/ublock'
        storage = folder / 'js/storage.js'
        original = storage.read_bytes()
        storage.write_bytes(original + b'\n// changed compiler\n')
        try:
            overlay.apply(tree, artifacts)
        except ValueError as error:
            assert 'contract differs' in str(error)
        else:
            raise AssertionError('Compiler drift was accepted')
        assert storage.read_bytes() == original + b'\n// changed compiler\n', 'Failed validation mutated source'
        storage.write_bytes(original)

        output = tree / 'out/gen/third_party/ublock'
        output.mkdir(parents=True)
        subprocess.run([sys.executable, str(folder / 'generate_file_list.py'), str(folder),
                        str(output / 'files.json'), str(output / 'compressed_assets.grdp'),
                        str(tree / 'out/gen')], cwd=tree, check=True)
        subprocess.run([sys.executable, str(tree / 'ui/webui/resources/tools/generate_grd.py'),
                        '--out-grd', str(output / 'ublock_resources.grd'), '--root-gen-dir', 'out/gen',
                        '--grd-prefix', 'ublock', '--resource-path-prefix', 'ublock',
                        '--manifest-files', str(output / 'files.json'),
                        '--grdp-files', str(output / 'compressed_assets.grdp')], cwd=tree, check=True)
        grit = source / 'tools/grit'
        subprocess.run([sys.executable, str(grit / 'grit.py'), '-i', str(output / 'ublock_resources.grd'),
                        'build', '-o', str(output / 'resources'), '-f', str(tree / 'tools/gritsettings/resource_ids.spec'),
                        '-D', 'SHARED_INTERMEDIATE_DIR=out/gen', '-E', f'root_src_dir={tree}',
                        '-E', f'root_gen_dir={tree}/out/gen'], cwd=tree, check=True)
        sys.path.insert(0, str(grit))
        from grit.format import data_pack
        resources = data_pack.ReadDataPack(str(output / 'resources/ublock_resources.pak')).resources
        header = (output / 'resources/grit/ublock_resources.h').read_text()
        ids = dict(re.findall(r'#define (IDR_\w+) (\d+)', header))
        generated = ET.parse(output / 'ublock_resources.grd')
        parts = [generated, ET.parse(output / 'compressed_assets.grdp')]
        entries = [entry for part in parts for entry in part.iter('include')]
        assert len(entries) <= 1000, 'uBlock resource ID reservation exceeded'
        expected, _ = overlay.prepare(tree, artifacts)
        packed_bytes = 0
        for name, data in expected.items():
            if name == 'BUILD.gn':
                continue
            entry = next(item for item in entries if item.get('resource_path') == f'ublock/{name}')
            packed = resources[int(ids[entry.get('name')])]
            packed_bytes += len(packed)
            if packed.startswith(b'\x1f\x8b'):
                packed = gzip.decompress(packed)
            assert packed == data, f'Packed resource bytes differ: {name}'
        registry = json.loads((folder / 'assets/assets.json').read_text())
        assert not any(key.startswith('breezer-compiled') for key in registry), 'Implementation artifacts became selectable lists'
        print(json.dumps({'status': 'passed', 'lists': len(json.loads((artifacts / 'index.json').read_text())['entries']),
                          'resourceCount': len(entries), 'verifiedResources': len(expected) - 1,
                          'packedBytesIncludingStorageModule': packed_bytes,
                          'checks': ['source and engine contract', 'idempotence', 'compiler drift rejection before mutation',
                                     'real GRIT bytes and gzip', 'resource ID budget', 'no selectable-list changes']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--artifacts', required=True, type=Path)
    args = parser.parse_args()
    check(args.source_dir.resolve(), args.artifacts.resolve())
