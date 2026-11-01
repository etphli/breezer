#!/usr/bin/env python3
"""Verify sync overlay composition against a disposable pinned source fixture.

This checks source integration, not native compilation or credential syncing.
It never reads profiles or mutates prepared source, compiled outputs or caches.
"""
import hashlib
from pathlib import Path
import tempfile

import apply_breezer_sync as sync
import apply_breezer_workspace as workspace
import check_ai_overlay as fixture


def hashes(tree):
    return {p.relative_to(tree).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in tree.rglob('*') if p.is_file()}


def main():
    with tempfile.TemporaryDirectory(prefix='breezer-sync-source-') as directory:
        base = Path(directory)
        fixture.CACHE = base / 'pristine'
        tree = base / 'source'
        tree.mkdir()
        fixture.prepare(tree, wanted_paths=set(sync.replacements()) | set(workspace.replacements()))
        workspace.apply(tree)
        pristine = hashes(tree)
        try:
            sync.apply(tree, check=True)
        except ValueError:
            pass
        else:
            raise AssertionError('Missing overlay accepted by --check')
        assert hashes(tree) == pristine
        assert sync.apply(tree) > 0
        installed = hashes(tree)
        assert sync.apply(tree, check=True) == 0
        assert sync.apply(tree) == 0
        assert hashes(tree) == installed
        # Downstream sync wiring must not invalidate workspace verification.
        assert workspace.apply(tree, check=True) == 0
        sentinel = tree / 'out/preserved-object'
        sentinel.parent.mkdir()
        sentinel.write_text('preserve compiled outputs')
        added = tree / 'chrome/browser/sync/breezer_sync/prefs.h'
        added.unlink()
        assert sync.apply(tree) == 1
        assert sentinel.read_text() == 'preserve compiled outputs'
        added.unlink()
        added.symlink_to(base / 'not-a-source-file')
        before = hashes(tree)
        try:
            sync.apply(tree)
        except ValueError as error:
            assert 'symlink' in str(error)
        else:
            raise AssertionError('Symlink accepted')
        assert hashes(tree) == before
        added.unlink()
        sync.apply(tree)
        target = tree / 'chrome/browser/sync/chrome_sync_client.h'
        target.write_text(target.read_text().replace('GetLocalSyncBackendFolder() override;', 'UnexpectedSourceDrift() override;'))
        before = hashes(tree)
        try:
            sync.apply(tree)
        except ValueError as error:
            assert 'drift' in str(error)
        else:
            raise AssertionError('Anchor drift accepted')
        assert hashes(tree) == before
    print('Sync source overlay: application, idempotence, workspace composition, interrupted retry, symlink/drift refusal and output preservation passed. Native compilation/runtime unverified.')


if __name__ == '__main__':
    main()
