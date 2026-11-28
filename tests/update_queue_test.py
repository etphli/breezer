"""Exercise the agent queue through its CLI and real Git worktrees."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class UpdateQueueTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.checkout = self.root / 'checkout'
        self.checkout.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Queue Test')
        self.git('config', 'user.email', 'queue-test@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'tag.gpgSign', 'false')
        scripts = self.checkout / 'script'
        scripts.mkdir()
        for name in ('breezer_update_queue.py', 'breezer_release.py'):
            shutil.copyfile(ROOT / 'script' / name, scripts / name)
        self.stamp('1.3.7')
        self.git('add', '.')
        self.git('commit', '-qm', 'Base')
        self.linked = self.root / 'linked'
        self.git('worktree', 'add', '-qb', 'agent-work', str(self.linked))

    def stamp(self, version):
        extension = self.checkout / 'features/ai/extension'
        extension.mkdir(parents=True, exist_ok=True)
        (extension / 'release-info.js').write_text(f"export const RELEASE_VERSION = '{version}';\n")
        (extension / 'manifest.json').write_text(json.dumps({'version': version}))

    def git(self, *args, checkout=None):
        result = subprocess.run(
            ['git', *args], cwd=checkout or self.checkout, capture_output=True, text=True, check=True)
        return result.stdout.strip()

    def queue(self, *args, checkout=None, error=None):
        script = (checkout or self.checkout) / 'script/breezer_update_queue.py'
        result = subprocess.run(
            [sys.executable, '-B', str(script), *args], cwd=self.root, capture_output=True, text=True)
        if error:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(error, result.stderr)
            return result.stderr
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def add(self, identifier, *args, **kwargs):
        return self.queue('add', identifier, '--title', identifier, '--details', 'Verify the result.', *args, **kwargs)

    def items(self, *args, **kwargs):
        return {item['id']: item for item in json.loads(self.queue('list', *args, **kwargs))['items']}

    def test_queue_is_shared_and_parallel_adds_survive(self):
        with ThreadPoolExecutor() as workers:
            futures = [
                workers.submit(self.add, f'item-{index}', checkout=checkout)
                for index, checkout in enumerate([self.checkout, self.linked] * 5)
            ]
            for future in futures:
                self.assertIn('Scheduled', future.result())
        self.assertEqual(self.items(), self.items(checkout=self.linked))
        self.assertEqual(len(self.items()), 10)
        self.assertIn('already recorded', self.add('item-1', checkout=self.linked))
        self.add('item-1', '--target', '1.4.0', error='already exists with different details or target')

    def test_planning_excludes_legacy_releases_and_keeps_late_requests(self):
        self.queue('plan', '1.3.7', error='after 1.3.7')
        self.add('legacy', '--target', '1.3.7', error='after 1.3.7')
        self.add('early')
        self.add('explicit', '--target', '1.4.0')
        self.queue('plan', '1.4.0')
        self.add('late', checkout=self.linked)
        self.queue('plan', '1.4.0')
        self.queue('plan', '1.4.1', error='1.4.0 is already active')
        self.assertEqual(set(self.items('--target', '1.4.0')), {'early', 'explicit'})
        self.assertEqual(set(self.items('--target', 'next')), {'late'})
        self.queue('abandon', '1.4.0', checkout=self.linked)
        self.assertEqual(set(self.items('--target', 'next')), {'early', 'late'})
        self.assertEqual(set(self.items('--target', '1.4.0')), {'explicit'})

    def test_candidate_checks_and_shipping(self):
        self.add('tab-fix')
        self.add('later-fix', '--target', '1.4.0')
        self.queue('plan', '1.3.8')
        self.stamp('1.3.8')
        self.queue('check', '1.3.8', error='declares 1.3.7')
        self.git('commit', '-qam', 'Version 1.3.8')
        self.queue('check', '1.3.8', error='tab-fix is queued')
        self.queue('ready', 'tab-fix', '--commit', 'missing', '--evidence', 'Verified',
                   error="'missing' does not resolve to a commit")
        (self.linked / 'tab-fix.txt').write_text('Fix')
        self.git('add', 'tab-fix.txt', checkout=self.linked)
        self.git('commit', '-qm', 'Fix tabs', checkout=self.linked)
        self.queue('ready', 'tab-fix', '--commit', 'HEAD', '--evidence', 'Tab checks passed.', checkout=self.linked)
        self.queue('check', '1.3.8', error='missing from the candidate')
        self.queue('ship', '1.3.8', error="'refs/tags/v1.3.8' does not resolve to a commit")
        self.git('tag', 'v1.3.8')
        self.queue('ship', '1.3.8', error='missing from the candidate')
        self.git('merge', '-q', '--no-edit', 'agent-work')
        self.assertIn('(1 scheduled)', self.queue('check', '1.3.8'))
        self.add('next-fix')
        self.add('deferred-fix', '--target', '1.3.8')
        self.queue('move', 'deferred-fix', '--target', 'backlog', '--reason', 'Deferred by the user.')
        self.git('tag', '-fa', 'v1.3.8', '-m', 'Release test')
        self.assertIn('Recorded', self.queue('ship', '1.3.8'))
        self.assertIn('already recorded', self.queue('ship', '1.3.8', checkout=self.linked))
        items = self.items()
        self.assertEqual(items['tab-fix']['status'], 'shipped')
        self.assertEqual(items['tab-fix']['evidence'], 'Tab checks passed.')
        self.assertEqual(items['next-fix']['release_target'], 'next')
        self.assertEqual(items['later-fix']['status'], 'queued')
        self.assertEqual(items['deferred-fix']['move_reason'], 'Deferred by the user.')
        self.queue('move', 'tab-fix', '--target', 'next', '--reason', 'Retry', error='shipped in 1.3.8')
        self.add('too-late', '--target', '1.3.8', error='already shipped')
        self.queue('plan', '1.4.0')
        self.assertEqual(set(self.items('--target', '1.4.0')), {'later-fix', 'next-fix'})

    def test_older_explicit_targets_must_be_resolved(self):
        self.add('older-fix', '--target', '1.3.9')
        self.queue('plan', '1.3.10')
        self.stamp('1.3.10')
        self.git('commit', '-qam', 'Version 1.3.10')
        self.queue('check', '1.3.10', error='older-fix is overdue from 1.3.9')
        self.queue('move', 'older-fix', '--target', 'next', '--reason', 'Roll to the next patch.')
        self.assertIn('(0 scheduled)', self.queue('check', '1.3.10'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
