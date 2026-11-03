#!/usr/bin/env python3
"""Stage the reviewed unattended runner and memory resources for the configured PC."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
BASELINES = {
    'page-context.js': '5f2d2162e260103aea561da9f83bc95b6c2608105db718f66b410fe2c8747790',
    'translation-content.js': 'b7b5284f1a0f7db0a88ff9f95893dabc0c10c256a7629c244dfed7e4a86a215f',
    'workspace.js': '7ca0a6b76bb2c17cb21d860b53ce66fa892d2c0d90fd1b6ca0a66402ff8c9953',
    'workspace-sync.js': 'a8d3fc3064758b6f1d7814a616bdbb82ba19d6df5dd71e65a31b9dccc073f1ea',
    'workspace-sync-model.js': 'f97e326df1b1ab8add1bcefa8c1aacbc0da08cc0adb9f0492c4e0264b55537f9',
    'workspace-store.js': '5055b78dfceddc6821c273f7ca1d855b47c046ae4e560b9797e36bd0dbb40b58',
    'newtab.js': '9be0e837b86f877f2c1aa25867f9ef017e61a4e76044fc2ea3a0f5f29b0d5d75',
    'panel.js': 'dc0f37319f2a650997d944a9ba0804b0f281501d61f122144759c61dae9495ca',
    'render-message.js': '9c756d4893099f0c9f2066422a9ff1b8db0bbba7b19136578e5b94aadd467830',
    'native-provider-transport.cc': '3660bf9123234227399b3081d44cebcb48d1c6575e77e91bbd83265b751fe1eb',
}
FILES = {
    'script/windows/unattended_build.py': 'unattended_build.py',
    'script/windows/apply-memory-update.py': 'apply-memory-update.py',
    'script/windows/continue-pc-browser-unattended.ps1': 'continue-pc-browser-unattended.ps1',
    'script/windows/prepare-unattended-build.ps1': 'prepare-unattended-build.ps1',
    'tests/windows/unattended_build_test.py': 'unattended_build_test.py',
    'tests/windows/unattended_cleanup_test.py': 'unattended_cleanup_test.py',
    'features/ai/extension/page-context.js': 'page-context.js',
    'features/ai/extension/translation-content.js': 'translation-content.js',
    'features/ai/extension/workspace.js': 'workspace.js',
    'features/ai/extension/workspace-sync.js': 'workspace-sync.js',
    'features/ai/extension/workspace-sync-model.js': 'workspace-sync-model.js',
    'features/ai/extension/workspace-store.js': 'workspace-store.js',
    'features/ai/extension/newtab.js': 'newtab.js',
    'features/ai/extension/panel.js': 'panel.js',
    'features/ai/extension/render-message.js': 'render-message.js',
    'features/sync/native/chrome/browser/sync/breezer_sync/provider_transport.cc': 'native-provider-transport.cc',
}
FILES.update({path.relative_to(ROOT).as_posix(): 'host-' + path.name
              for path in sorted((ROOT / 'features/ai/host').glob('*.mjs'))})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/efficiency-20261102/pc-packet')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for source, name in FILES.items():
        shutil.copyfile(ROOT / source, args.output / name)
    (args.output / 'memory-update.json').write_text(json.dumps({
        'resources': {name: {'before': before,
                             'after': hashlib.sha256((args.output / name).read_bytes()).hexdigest()}
                      for name, before in BASELINES.items()},
        'reason': 'Release detached page content, remove unused route markup and avoid redundant sync work and reply copies',
    }, indent=2) + '\n')
    (args.output / 'host-update.json').write_text(json.dumps({
        'resource': 'breezer_ai/host/protocol.mjs',
        'before': '26cf7b4bdd775003e1c303f9d31f3b02a052d382ef797c671c29a00a6351168d',
        'after': hashlib.sha256((args.output / 'host-protocol.mjs').read_bytes()).hexdigest(),
        'hostResources': {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in sorted((ROOT / 'features/ai/host').glob('*.mjs'))},
        'stage': 'Package the private native host on the Mac after compilation, then verify its bytes. Not a Chromium source migration.',
    }, indent=2) + '\n')
    paths = sorted([args.output / name for name in FILES.values()] + [args.output / 'memory-update.json', args.output / 'host-update.json'])
    (args.output / 'SHA256SUMS').write_text(''.join(
        hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in paths))
    print(args.output.resolve())


if __name__ == '__main__':
    main()
