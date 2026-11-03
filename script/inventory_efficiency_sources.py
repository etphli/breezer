#!/usr/bin/env python3
"""Record file hashes and line counts for Breezer's local efficiency audit."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CODE = {'.js', '.mjs', '.py', '.sh', '.ps1', '.psm1', '.c', '.cc', '.cpp', '.m', '.mm', '.h', '.idl', '.gn', '.patch', '.css', '.html', '.json'}


def owner(path):
    if path.startswith('script/'):
        return 'build-tools'
    if path.startswith('tests/'):
        return 'verification'
    if not path.startswith('features/ai/'):
        return 'native-and-sync'
    if not path.startswith('features/ai/extension/'):
        return 'native-host'
    name = Path(path).name
    if 'sync' in name:
        return 'native-and-sync'
    if name.startswith(('workspace', 'settings', 'onboarding', 'newtab', 'setup-state')):
        return 'workspace'
    if name.startswith(('translation', 'research', 'page-context', 'browser-tools')):
        return 'page-content'
    return 'extension-services'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/efficiency-20261103/source-inventory.json')
    args = parser.parse_args()
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'features', 'script', 'tests'], cwd=ROOT).decode().split('\0')
    files = []
    totals = {}
    for name in sorted(set(filter(None, names))):
        path = ROOT / name
        if path.suffix not in CODE or not path.is_file():
            continue
        data = path.read_bytes()
        text = data.decode('utf-8')
        group = owner(name)
        lines = len(text.splitlines())
        files.append({'path': name, 'owner': group, 'lines': lines, 'sha256': hashlib.sha256(data).hexdigest()})
        total = totals.setdefault(group, {'files': 0, 'lines': 0})
        total['files'] += 1
        total['lines'] += lines
    result = {'scope': 'Breezer-authored feature, script and test sources in this checkout, including current uncommitted files. Excludes vendored upstream code, generated build trees, binary assets, documentation and marketing sites.',
              'files': files, 'totals': totals, 'reviewed': False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(totals, indent=2))


if __name__ == '__main__':
    main()
