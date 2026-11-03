#!/usr/bin/env python3
"""Check source hashes and reported line ranges without treating an inventory as a review."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def covered(ranges, lines):
    end = 0
    for first, last in sorted(ranges):
        if not 1 <= first <= last <= lines:
            raise ValueError('Review range outside the source file')
        if first > end + 1:
            return False
        end = max(end, last)
    return end == lines


def check(inventory, reports):
    claims = {}
    for report in reports:
        for item in report['files']:
            if item['status'] == 'fully-read' and not covered(item['readRanges'], item['lines']):
                raise ValueError('Incomplete range claimed as fully read: ' + item['path'])
            claims.setdefault(item['path'], []).append(item)
    files = []
    for entry in inventory['files']:
        path = entry['path']
        actual = hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
        current = [item for item in claims.get(path, []) if item['sha256'] == actual and item['lines'] == entry['lines']]
        ranges = [bounds for item in current for bounds in item['readRanges']]
        status = 'fully-read' if covered(ranges, entry['lines']) else 'partial' if ranges else 'source-changed' if path in claims else 'pending'
        if actual != entry['sha256']:
            status = 'inventory-stale'
        files.append({**entry, 'status': status})
    return {'scope': inventory['scope'], 'meaning': 'Checks the consistency of reviewer coverage claims and current source bytes; does not prove correctness or runtime performance.',
            'files': files, 'complete': all(item['status'] == 'fully-read' for item in files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--reports', nargs='+', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = check(json.loads(args.inventory.read_text()), [json.loads(path.read_text()) for path in args.reports])
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print('Coverage claims checked. All sources reviewed: ' + str(result['complete']))


if __name__ == '__main__':
    main()
