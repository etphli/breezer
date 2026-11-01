#!/usr/bin/env python3
"""Stage an opt-in, fingerprinted compiled-list experiment before GN/GRIT."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tempfile

ROOT = Path(__file__).resolve().parent.parent
FEATURE = ROOT / 'features/performance'
OWNED = {
    'js/breezer-compiled-filter-lists.js',
    'js/breezer-compiled-filter-context.js',
    'js/breezer-compiled-filter-build.js',
}
IMPORT = "import { bundledFilterLists } from './breezer-compiled-filter-context.js';\n"
ANCHOR = '''    const compiledContent = this.compileFilters(rawDetails.content, {
        assetKey,
        trustedSource: this.isTrustedList(assetKey),
    });
    io.toCache(compiledPath, compiledContent);

    return { assetKey, content: compiledContent };'''
HOOK = '''    const trustedSource = this.isTrustedList(assetKey);
    return bundledFilterLists.read({
        assetKey,
        rawText: rawDetails.content,
        trustedSource,
    }, bundled => {
        if ( bundled.kind === 'retry' ) {
            return this.getCompiledFilterList(assetKey);
        }
        if ( this.badLists.has(assetKey) ) {
            return { assetKey, content: '' };
        }
        const compiledContent = bundled.kind === 'hit' && trustedSource === this.isTrustedList(assetKey)
            ? bundled.content
            : this.compileFilters(rawDetails.content, {
                assetKey,
                trustedSource: this.isTrustedList(assetKey),
            });
        io.toCache(compiledPath, compiledContent);

        return { assetKey, content: compiledContent };
    });
'''.rstrip()
GN_MARKER = '    # Breezer compiled-list experiment inputs.\n'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unhook(text):
    if IMPORT in text or HOOK in text:
        if text.count(IMPORT) != 1 or text.count(HOOK) != 1:
            raise ValueError('Partial or changed compiled-list hook; preserve this tree and prepare a fresh one')
        return text.replace(IMPORT, '', 1).replace(HOOK, ANCHOR, 1)
    if text.count(ANCHOR) != 1:
        raise ValueError('Pinned filter compiler seam changed')
    return text


def contract_for(tree):
    folder = tree / 'third_party/ublock'
    hashes = {}
    for path in sorted(folder.rglob('*.js')):
        name = path.relative_to(folder).as_posix()
        if not name.startswith(('js/', 'lib/')) or name in OWNED:
            continue
        data = path.read_bytes()
        if name == 'js/storage.js':
            data = unhook(data.decode()).encode()
        hashes[name] = digest(data)
    version = (tree / 'chrome/VERSION').read_text()
    chrome = '.'.join(re.search(rf'^{key}=(\d+)$', version, re.M)[1]
                      for key in ['MAJOR', 'MINOR', 'BUILD', 'PATCH'])
    v8 = (tree / 'v8/include/v8-version.h').read_text()
    js = '.'.join(re.search(rf'^#define V8_{key} (\d+)$', v8, re.M)[1]
                  for key in ['MAJOR_VERSION', 'MINOR_VERSION', 'BUILD_NUMBER', 'PATCH_LEVEL'])
    return {'sourceHashes': hashes, 'engineVersion': f'Chrome/{chrome}', 'engineJavaScriptVersion': js}


def prepare(tree, artifacts):
    contract = json.loads((artifacts / 'contract.json').read_text())
    if contract != contract_for(tree):
        raise ValueError('Compiled-list compiler/engine contract differs from this source tree; regenerate')
    index_bytes = (artifacts / 'index.json').read_bytes()
    if len(index_bytes) > 64 * 1024:
        raise ValueError('Compiled-list index exceeds its runtime limit')
    index = json.loads(index_bytes)
    build_id = digest(canonical(contract).encode())
    if index['schema'] != 1 or index['buildId'] != build_id or not 0 < len(index['entries']) <= 64:
        raise ValueError('Invalid compiled-list index contract')
    for key in ['engineVersion', 'engineJavaScriptVersion']:
        if index['context'][key] != contract[key]:
            raise ValueError('Compiled-list engine context differs')
    files = {'assets/breezer-compiled/index.json': index_bytes}
    for key, entry in index['entries'].items():
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', key) or key.startswith('user-'):
            raise ValueError('Only built-in list keys are eligible')
        sha = entry['payloadSha256']
        if not re.fullmatch(r'[a-f0-9]{64}', sha) or entry['path'] != f'{sha}.txt':
            raise ValueError('Unsafe compiled-list payload path')
        if (type(entry['rawBytes']) is not int or not 0 < entry['rawBytes'] <= 8 * 1024 * 1024
                or type(entry['payloadBytes']) is not int or not 0 < entry['payloadBytes'] <= 16 * 1024 * 1024
                or type(entry['trustedSource']) is not bool or not re.fullmatch(r'[a-f0-9]{64}', entry['rawSha256'])):
            raise ValueError('Invalid compiled-list bounds or trust metadata')
        path = artifacts / entry['path']
        if path.stat().st_size != entry['payloadBytes']:
            raise ValueError('Compiled-list payload size differs')
        data = path.read_bytes()
        if digest(data) != sha or not data.decode('utf-8').startswith(f"{index['context']['compiledMagic']}\n"):
            raise ValueError('Compiled-list payload integrity differs')
        files[f'assets/breezer-compiled/{entry["path"]}'] = data
    files['js/breezer-compiled-filter-lists.js'] = (FEATURE / 'compiled-filter-lists.mjs').read_bytes()
    files['js/breezer-compiled-filter-context.js'] = (FEATURE / 'compiled-filter-context.js').read_bytes()
    stamp = {'buildId': build_id, **{key: contract[key] for key in ['engineVersion', 'engineJavaScriptVersion']}}
    files['js/breezer-compiled-filter-build.js'] = ''.join(f'export const {key} = {json.dumps(value)};\n' for key, value in stamp.items()).encode()
    folder = tree / 'third_party/ublock'
    existing = {path.relative_to(folder).as_posix() for path in (folder / 'assets/breezer-compiled').rglob('*') if path.is_file()}
    if existing - files.keys():
        raise ValueError('Unexpected compiled-list resources remain; preserve this tree and use a fresh source snapshot')
    baseline = unhook((folder / 'js/storage.js').read_text())
    import_anchor = "import * as sfp from './static-filtering-parser.js';\n"
    if baseline.count(import_anchor) != 1:
        raise ValueError('Pinned filter import anchor changed')
    files['js/storage.js'] = baseline.replace(import_anchor, IMPORT + import_anchor, 1).replace(ANCHOR, HOOK, 1).encode()
    gn = (folder / 'BUILD.gn').read_text()
    if GN_MARKER in gn:
        gn = re.sub(re.escape(GN_MARKER) + r'.*?    # End Breezer compiled-list inputs\.\n', '', gn, count=1, flags=re.S)
    gn_anchor = '        "generate_file_list.py",\n'
    if gn.count(gn_anchor) != 1:
        raise ValueError('Pinned filter GN input anchor changed')
    gn_inputs = GN_MARKER + ''.join(f'        "{name}",\n' for name in sorted(files)) + '    # End Breezer compiled-list inputs.\n'
    files['BUILD.gn'] = gn.replace(gn_anchor, gn_anchor + gn_inputs, 1).encode()
    marker = canonical({name: digest(data) for name, data in sorted(files.items())}).encode() + b'\n'
    return files, marker


def apply(tree, artifacts, check=False):
    files, marker = prepare(tree, artifacts)
    marker_path = tree / '.breezer-filter-lists-prepared'
    if marker_path.exists() and marker_path.read_bytes() != marker:
        raise ValueError('Compiled-list experiment changed; preserve this tree and use a fresh source snapshot')
    folder = tree / 'third_party/ublock'
    if check:
        if not marker_path.exists() or marker_path.read_bytes() != marker:
            raise ValueError('Compiled-list preparation marker is missing')
        for name, data in files.items():
            if (folder / name).read_bytes() != data:
                raise ValueError(f'Compiled-list staged bytes differ: {name}')
        return
    # All input validation precedes mutation. Each file replacement is atomic;
    # retrying a partial run converges to the same complete staged resources.
    for name, data in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.read_bytes() == data:
            continue
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.breezer-filter-', delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
        temporary.replace(path)
    marker_path.write_bytes(marker)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_dir', type=Path)
    parser.add_argument('--artifacts', required=True, type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    apply(args.source_dir.resolve(), args.artifacts.resolve(), args.check)
    print('Compiled-list experimental overlay verified.' if args.check else 'Compiled-list experimental overlay staged.')
