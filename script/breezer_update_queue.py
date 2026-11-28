#!/usr/bin/env python3
"""Schedule work for Breezer releases across local Git worktrees."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import subprocess

from breezer_release import parse_release_version


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = 'features/ai/extension'
LAST_LEGACY_RELEASE = (1, 3, 7)
ITEMS_QUERY = """
    SELECT items.*, COALESCE(planned_version, target) AS release_target, shipped_commit
    FROM items LEFT JOIN releases ON releases.version = COALESCE(planned_version, target)
"""


def version_key(version):
    return tuple(map(int, version.split('.')))


def future_version(value):
    if not re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}', value):
        raise argparse.ArgumentTypeError('Use a plain version such as 1.4.0.')
    if version_key(value) <= LAST_LEGACY_RELEASE:
        raise argparse.ArgumentTypeError('The queue starts with releases after 1.3.7.')
    return value


def target(value):
    return value if value in ('next', 'backlog') else future_version(value)


def item_id(value):
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', value):
        raise argparse.ArgumentTypeError('Use a lowercase ID such as sidebar-search.')
    return value


def nonempty(value):
    if not value.strip():
        raise argparse.ArgumentTypeError('Enter a nonempty value.')
    return value.strip()


def git(*args, allow_no_match=False):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True)
    if result.returncode == 1 and allow_no_match:
        return None
    if result.returncode:
        raise ValueError(result.stderr.strip() or f'Git could not run {args[0]}.')
    return result.stdout


def resolve_commit(ref):
    commit = git('rev-parse', '--verify', '--quiet', '--end-of-options', f'{ref}^{{commit}}',
                 allow_no_match=True)
    if commit is None:
        raise ValueError(f'Git ref {ref!r} does not resolve to a commit.')
    return commit.strip()


def open_queue():
    common_dir = git('rev-parse', '--path-format=absolute', '--git-common-dir').strip()
    db = sqlite3.connect(Path(common_dir) / 'breezer-update-queue.sqlite3')
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys = ON')
    db.executescript("""
        CREATE TABLE IF NOT EXISTS releases (
            version TEXT PRIMARY KEY,
            shipped_commit TEXT
        );
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            details TEXT NOT NULL,
            target TEXT NOT NULL,
            planned_version TEXT REFERENCES releases(version),
            verified_commit TEXT,
            evidence TEXT,
            move_reason TEXT
        );
    """)
    return db


def active_release(db):
    row = db.execute('SELECT version FROM releases WHERE shipped_commit IS NULL').fetchone()
    return row['version'] if row else None


def require_active_release(db, version):
    active = active_release(db)
    if active != version:
        raise ValueError(f'Active release is {active or "unset"}. Run plan {version} to start a release.')


def require_available_target(db, destination):
    if destination in ('next', 'backlog'):
        return
    shipped = db.execute('SELECT version FROM releases WHERE shipped_commit IS NOT NULL')
    if any(version_key(destination) <= version_key(row['version']) for row in shipped):
        raise ValueError(f'{destination} has already shipped or precedes a shipped release.')


def get_item(db, identifier):
    row = db.execute(ITEMS_QUERY + 'WHERE id = ?', (identifier,)).fetchone()
    if row is None:
        raise ValueError(f'Unknown item {identifier}.')
    return row


def require_open_item(db, identifier):
    item = get_item(db, identifier)
    if item['shipped_commit']:
        raise ValueError(f'{identifier} shipped in {item["release_target"]}.')
    return item


def add_item(db, args):
    existing = db.execute('SELECT title, details, target FROM items WHERE id = ?', (args.id,)).fetchone()
    values = (args.title, args.details, args.target)
    if existing is not None:
        if tuple(existing) != values:
            raise ValueError(f'{args.id} already exists with different details or target.')
        return f'{args.id} is already recorded for {get_item(db, args.id)["release_target"]}.'
    require_available_target(db, args.target)
    db.execute('INSERT INTO items (id, title, details, target) VALUES (?, ?, ?, ?)', (args.id, *values))
    return f'Scheduled {args.id} for {args.target}.'


def list_items(db, args):
    active = active_release(db)
    items = []
    for row in db.execute(ITEMS_QUERY + 'ORDER BY id'):
        item = dict(row)
        if item['shipped_commit']:
            item['status'] = 'shipped'
        elif item['verified_commit']:
            item['status'] = 'ready'
        else:
            item['status'] = 'queued'
        if args.target is None or item['release_target'] == args.target:
            items.append(item)
    return json.dumps({'active_release': active, 'items': items}, indent=2)


def mark_ready(db, args):
    require_open_item(db, args.id)
    commit = resolve_commit(args.commit)
    db.execute('UPDATE items SET verified_commit = ?, evidence = ? WHERE id = ?',
               (commit, args.evidence, args.id))
    return f'Marked {args.id} ready at {commit}.'


def move_item(db, args):
    item = require_open_item(db, args.id)
    require_available_target(db, args.target)
    if item['release_target'] == args.target and item['planned_version'] is None:
        return f'{args.id} is already assigned to {args.target}.'
    db.execute('UPDATE items SET target = ?, planned_version = NULL, move_reason = ? WHERE id = ?',
               (args.target, args.reason, args.id))
    return f'Moved {args.id} to {args.target}.'


def plan_release(db, args):
    active = active_release(db)
    if active == args.version:
        return f'{active} is already planned. New next items stay queued until the following plan.'
    if active:
        raise ValueError(f'{active} is already active. Finish it or abandon it before planning {args.version}.')
    require_available_target(db, args.version)
    db.execute('INSERT INTO releases (version) VALUES (?)', (args.version,))
    assigned = db.execute("""
        UPDATE items SET planned_version = ? WHERE target = 'next' AND planned_version IS NULL
    """, (args.version,)).rowcount
    return f'Planned {args.version} and assigned {assigned} next items. Run list --target {args.version}.'


def abandon_release(db, args):
    require_active_release(db, args.version)
    db.execute('UPDATE items SET planned_version = NULL WHERE planned_version = ?', (args.version,))
    db.execute('DELETE FROM releases WHERE version = ?', (args.version,))
    return f'Abandoned {args.version}. Automatically assigned items are back in next.'


def verify_candidate(db, version, commit):
    require_active_release(db, version)
    actual_version = parse_release_version(
        git('show', f'{commit}:{EXTENSION}/release-info.js'),
        git('show', f'{commit}:{EXTENSION}/manifest.json'),
    )
    if actual_version != version:
        raise ValueError(f'Candidate {commit} declares {actual_version}. Expected {version}.')

    blockers = []
    count = 0
    rows = db.execute("""
        SELECT id, COALESCE(planned_version, target) AS release_target, verified_commit
        FROM items
        LEFT JOIN releases ON releases.version = COALESCE(planned_version, target)
        WHERE shipped_commit IS NULL AND COALESCE(planned_version, target) NOT IN ('next', 'backlog')
        ORDER BY id
    """)
    for item in rows:
        identifier = item['id']
        destination = item['release_target']
        verified = item['verified_commit']
        if version_key(destination) < version_key(version):
            blockers.append(f'{identifier} is overdue from {destination}. Move it to {version} or a later target.')
        elif destination == version:
            count += 1
            if not verified:
                blockers.append(f'{identifier} is queued. Verify it and mark it ready, or move it.')
            elif git('merge-base', '--is-ancestor', verified, commit, allow_no_match=True) is None:
                blockers.append(f'{identifier} was verified at {verified}, which is missing from the candidate.')
    if blockers:
        raise ValueError(f'{version} is blocked:\n' + '\n'.join(f'- {blocker}' for blocker in blockers))
    return count


def check_release(db, args):
    commit = resolve_commit(args.ref)
    count = verify_candidate(db, args.version, commit)
    return f'{args.version} queue check passed at {commit} ({count} scheduled).'


def ship_release(db, args):
    commit = resolve_commit(f'refs/tags/v{args.version}')
    recorded = db.execute('SELECT shipped_commit FROM releases WHERE version = ?', (args.version,)).fetchone()
    if recorded and recorded['shipped_commit']:
        if recorded['shipped_commit'] != commit:
            raise ValueError(f'v{args.version} differs from the recorded shipped commit.')
        return f'{args.version} is already recorded as shipped at {commit}.'
    count = verify_candidate(db, args.version, commit)
    db.execute('UPDATE releases SET shipped_commit = ? WHERE version = ?', (commit, args.version))
    return f'Recorded {args.version} as shipped at {commit} ({count} scheduled).'


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)

    add = commands.add_parser('add', help='Queue a request with a stable ID')
    add.add_argument('id', type=item_id)
    add.add_argument('--title', required=True, type=nonempty)
    add.add_argument('--details', required=True, type=nonempty, help='Requested outcome and acceptance criteria')
    add.add_argument('--target', type=target, default='next')
    add.set_defaults(run=add_item)

    listing = commands.add_parser('list', help='Show the queue and release history as JSON')
    listing.add_argument('--target', type=target)
    listing.set_defaults(run=list_items)

    ready = commands.add_parser('ready', help='Record verified work and the commit that contains it')
    ready.add_argument('id', type=item_id)
    ready.add_argument('--commit', required=True)
    ready.add_argument('--evidence', required=True, type=nonempty)
    ready.set_defaults(run=mark_ready)

    move = commands.add_parser('move', help='Reschedule an item or put it in the backlog')
    move.add_argument('id', type=item_id)
    move.add_argument('--target', required=True, type=target)
    move.add_argument('--reason', required=True, type=nonempty)
    move.set_defaults(run=move_item)

    plan = commands.add_parser('plan', help='Assign waiting next items to a release')
    plan.add_argument('version', type=future_version)
    plan.set_defaults(run=plan_release)

    abandon = commands.add_parser('abandon', help='Close an unshipped plan and return its next items to the queue')
    abandon.add_argument('version', type=future_version)
    abandon.set_defaults(run=abandon_release)

    check = commands.add_parser('check', help='Check that scheduled work is in the versioned candidate')
    check.add_argument('version', type=future_version)
    check.add_argument('--ref', default='HEAD')
    check.set_defaults(run=check_release)

    ship = commands.add_parser('ship', help='Record a verified, published release from its local vVERSION tag')
    ship.add_argument('version', type=future_version)
    ship.set_defaults(run=ship_release)
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        with closing(open_queue()) as db, db:
            db.execute('BEGIN' if args.command in ('list', 'check') else 'BEGIN IMMEDIATE')
            message = args.run(db, args)
        print(message)
    except (OSError, sqlite3.Error, ValueError) as error:
        raise SystemExit(str(error)) from None


if __name__ == '__main__':
    main()
