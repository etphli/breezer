#!/usr/bin/env python3
"""Exercise the AI overlay against pinned Chromium source and Helium patches.

Fetches a small source fixture into build/ai-check, then applies only the relevant
file sections of the pinned upstream patch series. Never changes vendor files.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import gzip
import json
from pathlib import Path
import re
import shutil
import sys
import subprocess
import tempfile

import apply_breezer_ai as ai

VERSION = '156.0.8078.47'
CACHE = ai.ROOT / 'build/ai-check/pristine'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(path):
    destination = CACHE / path
    if not destination.is_file():
        destination.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error',
                        f'https://raw.githubusercontent.com/chromium/chromium/{VERSION}/{path}',
                        '--output', str(destination)], check=True)
    return destination


def file_sections(patch):
    return re.split(r'(?=^--- (?:a/|/dev/null))', patch.read_text(), flags=re.MULTILINE)


def upstream_series():
    lock = json.loads((ai.ROOT / 'upstream.lock.json').read_text())
    for key in ('helium', 'helium_macos'):
        patches = ai.ROOT / lock[key]['path'] / 'patches'
        for line in (patches / 'series').read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#'):
                yield patches / line


def prepare(tree, offline=False):
    wanted = set(ai.PATCHED_FILES)
    new_files = set()
    sections = []
    for patch in upstream_series():
        selected = []
        for section in file_sections(patch):
            match = re.search(r'^\+\+\+ b/(\S+)', section, re.MULTILINE)
            if match and match[1] in wanted:
                selected.append(section)
                if section.startswith('--- /dev/null'):
                    new_files.add(match[1])
        if selected:
            sections.append((patch, ''.join(selected)))
    originals = wanted - new_files
    if offline:
        missing = [path for path in originals if not (CACHE / path).is_file()]
        if missing:
            raise ValueError(f'Offline fixture is missing: {missing}')
    else:
        with ThreadPoolExecutor(max_workers=6) as executor:
            list(executor.map(fetch, sorted(originals)))
    for path in originals:
        target = tree / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(CACHE / path, target)
    for patch, body in sections:
        result = subprocess.run(['patch', '--batch', '-p1', '-d', str(tree)],
                                input=body, capture_output=True, text=True)
        if result.returncode:
            raise ValueError(f'{patch.name} failed against source fixture:\n{result.stdout}\n{result.stderr}')
    return originals


def check_resources(tree, grit_directory, offline=False):
    generator_path = 'ui/webui/resources/tools/generate_grd.py'
    generator = CACHE / generator_path if offline else fetch(generator_path)
    if not generator.is_file():
        raise ValueError('Pinned generate_grd.py is missing from the offline cache')
    component = tree / 'components/breezer_ai'
    files = sorted(path.relative_to(component).as_posix()
                   for path in component.rglob('*')
                   if path.is_file() and path.name != 'BUILD.gn')
    output = tree / 'out/gen/components/breezer_ai'
    output.mkdir(parents=True)
    subprocess.run([sys.executable, str(generator), '--out-grd',
                    'out/gen/components/breezer_ai/resources.grd',
                    '--root-gen-dir', 'out/gen', '--grd-prefix', 'breezer_ai',
                    '--resource-path-prefix', 'breezer_ai',
                    '--input-files-base-dir', 'components/breezer_ai',
                    '--input-files', *files], cwd=tree, check=True)
    subprocess.run([sys.executable, str(grit_directory / 'grit.py'), '-i',
                    str(output / 'resources.grd'), 'build', '-o',
                    str(output / 'resources'), '-f',
                    str(tree / 'tools/gritsettings/resource_ids.spec'),
                    '-D', 'SHARED_INTERMEDIATE_DIR=out/gen',
                    '-E', f'root_src_dir={tree}',
                    '-E', f'root_gen_dir={tree}/out/gen'], cwd=tree, check=True)
    resources = output / 'resources'
    resource_map = (resources / 'grit/breezer_ai_resources_map.cc').read_text()
    header = (resources / 'grit/breezer_ai_resources.h').read_text()
    assert f'kBreezerAiResources[{len(files)}]' in resource_map
    for path in files:
        assert f'"breezer_ai/{path}"' in resource_map
    manifest_id = int(re.search(r'#define IDR_BREEZER_AI_MANIFEST_JSON (\d+)', header)[1])
    sys.path.insert(0, str(grit_directory))
    from grit.format import data_pack
    packed = data_pack.ReadDataPack(str(resources / 'breezer_ai_resources.pak'))
    payload = packed.resources[manifest_id]
    if payload.startswith(b'\x1f\x8b'):
        payload = gzip.decompress(payload)
    assert payload == (component / 'manifest.json').read_bytes()


def check(tree, grit_directory=None, offline=False):
    ai.apply(tree)
    paths = sorted(path for path in tree.rglob('*') if path.is_file())
    first = {str(path.relative_to(tree)): sha(path) for path in paths}
    ai.apply(tree)
    assert first == {str(path.relative_to(tree)): sha(path) for path in paths}, 'Overlay is not idempotent'
    component = tree / 'components/breezer_ai'
    manifest = json.loads((component / 'manifest.json').read_text())
    public = __import__('base64').b64decode(manifest['key'])
    actual_id = ''.join(chr(ord('a') + int(c, 16)) for c in hashlib.sha256(public).hexdigest()[:32])
    assert actual_id == ai.EXTENSION_ID
    host = json.loads((ai.ROOT / 'features/ai/integration/native-host-manifest.json').read_text())
    assert host['allowed_origins'] == [f'chrome-extension://{actual_id}/']
    assert host['name'] == ai.HOST and host['path'] == 'host/launch.sh'
    assert 'host_permissions' not in manifest
    assert manifest['incognito'] == 'not_allowed'
    for file in (ai.ROOT / 'features/ai/extension').rglob('*'):
        if file.is_file():
            assert file.read_bytes() == (component / file.relative_to(ai.ROOT / 'features/ai/extension')).read_bytes()
    launcher = (tree / 'chrome/browser/extensions/api/messaging/launch_context_posix.cc').read_text()
    assert launcher.index(f'host_name == "{ai.HOST}"') < launcher.index('if (allow_user_level_hosts)')
    command = (tree / 'chrome/browser/ui/browser_command_controller.cc').read_text()
    assert 'granter->GrantIfRequested(extension)' in command
    assert 'side_panel->Toggle(' in command
    if grit_directory:
        check_resources(tree, grit_directory, offline)
    # Source changes must fail closed when upstream moves a required anchor.
    target = tree / 'chrome/browser/extensions/component_loader.h'
    target.write_text(target.read_text().replace('  void AddExtstoreFixups();\n  void AddBreezerAi();', '  void ChangedUpstream();'))
    try:
        ai.apply(tree)
    except ValueError:
        pass
    else:
        raise AssertionError('Changed upstream anchor did not fail')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--grit-directory', type=Path,
                        help='Optional pinned Chromium tools/grit directory to build and inspect the extension PAK')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='breezer-ai-overlay-') as directory:
        tree = Path(directory).resolve()
        originals = prepare(tree, args.offline)
        check(tree, args.grit_directory.resolve() if args.grit_directory else None, args.offline)
    print(f'PASS: overlay on Chromium {VERSION} plus both pinned Helium patch series ({len(originals)} source files), resources, exact host origin, activeTab grant, idempotence, and anchor drift.')
    if args.grit_directory:
        print('PASS: actual Chromium generate_grd and GRIT build, generated C++ resource map, and packed manifest bytes.')
    print('Native compilation and real Cmd+K behavior still require the full macOS browser build.')


if __name__ == '__main__':
    main()
