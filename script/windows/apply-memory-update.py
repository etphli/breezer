#!/usr/bin/env python3
"""Migrate checked extension/native resources and PC worker pins while stopped."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_bytes(path, content):
    temporary = path.with_suffix(path.suffix + '.memory-update.tmp')
    with temporary.open('wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def apply(source, plan_path, packet):
    updates = json.loads((packet / 'memory-update.json').read_text())['resources']
    resources = {name: 'components/breezer_ai/' + name for name in (
        'page-context.js', 'translation-content.js', 'workspace.js', 'workspace-sync.js', 'workspace-sync-model.js',
        'workspace-store.js', 'newtab.js', 'panel.js', 'render-message.js')}
    resources['native-provider-transport.cc'] = 'chrome/browser/sync/breezer_sync/provider_transport.cc'
    if set(updates) != set(resources):
        raise ValueError('Unexpected memory resource set')
    plan = json.loads(plan_path.read_text())
    migrations = []
    for name, relative in resources.items():
        update = updates[name]
        target = source / relative
        replacement = (packet / name).read_bytes()
        if hashlib.sha256(replacement).hexdigest() != update['after']:
            raise ValueError('Packet resource hash mismatch: ' + name)
        if sha(target) not in (update['before'], update['after']):
            raise ValueError('Unexpected prepared source; preserve and inspect: ' + name)
        record = plan['sourceChanges'][relative]
        if record['after'] not in (update['before'], update['after']):
            raise ValueError('Unexpected pinned resource; preserve and inspect: ' + name)
        migrations.append((target, replacement, record, update))
    # Validate every input before writing. An interruption between resource and
    # pin writes can be resumed from either checked source version.
    plan_backup = plan_path.with_suffix('.json.before-memory-update.bak')
    if not plan_backup.exists():
        replace_bytes(plan_backup, plan_path.read_bytes())
    for target, replacement, record, update in migrations:
        backup = target.with_suffix(target.suffix + '.before-memory-update.bak')
        if not backup.exists() and sha(target) == update['before']:
            replace_bytes(backup, target.read_bytes())
        if sha(target) != update['after']:
            replace_bytes(target, replacement)
        record['after'] = update['after']
    content = (json.dumps(plan, indent=2) + '\n').encode()
    if plan_path.read_bytes() != content:
        replace_bytes(plan_path, content)
    saved = json.loads(plan_path.read_text())
    for target, _, _, _ in migrations:
        relative = target.relative_to(source).as_posix()
        if sha(target) != saved['sourceChanges'][relative]['after']:
            raise ValueError('Migrated resource and source pin differ: ' + relative)
    os.sync()
    print('Memory resources and worker pins verified. Graph and compiled outputs preserved.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--plan', type=Path, required=True)
    args = parser.parse_args()
    output = args.source / 'out/PCMacPerformance'
    with (output / '.breezer-unattended.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        processes = subprocess.check_output(['ps', '-eo', 'args='], text=True)
        if any('ninja' in line and str(output) in line for line in processes.splitlines()):
            raise RuntimeError('Compiler still running; leave source untouched')
        apply(args.source, args.plan, Path(__file__).resolve().parent)


if __name__ == '__main__':
    main()
