"""Cleanup retries use only fake workers, groups and process discovery."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(os.environ.get('BREEZER_SUPERVISOR_SCRIPT', ROOT / 'script/windows/unattended_build.py'))
spec = importlib.util.spec_from_file_location('cleanup_supervisor', SCRIPT)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class CleanupTest(unittest.TestCase):
    def setUp(self):
        self.running = True
        self.stopped = False
        self.driver = True
        self.stranger = False
        self.calls = 0
        self.signals = []
        self.fail_calls = set()
        self.child = types.SimpleNamespace(pid=1000, poll=lambda: None if self.running else 0,
                                           terminate=self.terminate, kill=self.kill, wait=self.wait)
        self.previous = supervisor.os, supervisor.sys, supervisor.process_table
        supervisor.os = types.SimpleNamespace(kill=self.signal_worker, killpg=self.signal_group,
                                              getpgrp=lambda: 900, getpid=lambda: 900)
        supervisor.sys = types.SimpleNamespace(platform='darwin')
        supervisor.process_table = self.table
        self.addCleanup(self.restore)

    def restore(self):
        supervisor.os, supervisor.sys, supervisor.process_table = self.previous

    def terminate(self):
        self.signals.append(('worker', supervisor.signal.SIGTERM))
        if not self.stopped:
            self.running = False

    def kill(self):
        self.running = False

    def wait(self, timeout=None):
        if self.running:
            raise subprocess.TimeoutExpired('fake worker', timeout)
        return 0

    def signal_worker(self, pid, signum):
        self.signals.append((pid, signum))
        if signum == supervisor.signal.SIGSTOP:
            self.stopped = True
        if signum == supervisor.signal.SIGCONT:
            self.stopped = False
            if ('worker', supervisor.signal.SIGTERM) in self.signals:
                self.running = False

    def signal_group(self, group, signum):
        self.signals.append(('group', group, signum))
        if group == 2000 and self.driver:
            self.driver = False

    def table(self):
        self.calls += 1
        if self.calls in self.fail_calls:
            raise OSError('Synthetic transient process discovery failure')
        result = {}
        if self.running:
            result[1000] = (900, 1000, 'T' if self.stopped else 'R')
        if self.driver:
            result[2000] = (1000 if self.running else 1, 2000, 'S')
        if self.stranger:
            result[3000] = (1, 2000, 'S')
        return result

    def stop(self):
        supervisor.stop_worker(self.child, ROOT / 'build/efficiency-20261103/nonexistent-cleanup-state.json', grace=.01)

    def test_transient_discovery_failure_cannot_disable_cleanup(self):
        self.fail_calls = {1}
        try:
            self.stop()
        except OSError:
            pass
        self.stop()
        self.assertFalse(self.running)
        self.assertFalse(self.driver)
        self.assertFalse(self.stopped)
        self.assertTrue(self.child.breezer_cleanup_complete)
        calls = self.calls
        self.stop()
        self.assertEqual(self.calls, calls, 'confirmed cleanup is idempotent')

    def test_failure_after_discovery_preserves_groups_for_final_retry(self):
        self.fail_calls = {2, 3, 4}
        with self.assertRaises(OSError):
            self.stop()
        self.assertFalse(self.running, 'failure must not leave the owned worker frozen')
        self.assertFalse(self.stopped)
        self.assertTrue(self.driver)
        self.stop()
        self.assertFalse(self.driver)
        self.assertTrue(self.child.breezer_cleanup_complete)

    def test_cached_group_with_no_known_member_is_not_signalled(self):
        self.fail_calls = {2, 3, 4}
        with self.assertRaises(OSError):
            self.stop()
        self.driver = False
        self.stranger = True
        with self.assertRaisesRegex(RuntimeError, 'ownership'):
            self.stop()
        self.assertFalse(any(item[0] == 'group' for item in self.signals))
        self.assertFalse(getattr(self.child, 'breezer_cleanup_complete', False))

    def test_permanent_discovery_failure_does_not_leave_a_frozen_worker(self):
        self.fail_calls = set(range(1, 100))
        with self.assertRaises(OSError):
            self.stop()
        self.assertFalse(self.running)
        self.assertFalse(self.stopped)
        self.assertFalse(getattr(self.child, 'breezer_cleanup_complete', False))


@unittest.skipUnless(os.name == 'posix', 'POSIX process ownership fixture')
class RealCleanupTest(unittest.TestCase):
    def test_transient_discovery_failure_reaps_owned_worker_and_detached_driver(self):
        supervisor.enable_subreaper()
        with tempfile.TemporaryDirectory(prefix='breezer-cleanup-fault-') as directory:
            root = Path(directory)
            ready = root / 'driver-pid'
            code = ('import subprocess,sys\nfrom pathlib import Path\n'
                    'child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],start_new_session=True)\n'
                    f'Path({str(ready)!r}).write_text(str(child.pid))\nchild.wait()\n')
            child = subprocess.Popen([sys.executable, '-c', code], start_new_session=True,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            driver = None
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(ready.exists())
                driver = int(ready.read_text())
                actual_table = supervisor.process_table
                calls = 0

                def transient_failure():
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        raise OSError('Synthetic discovery failure with real owned processes')
                    return actual_table()

                with patch.object(supervisor, 'process_table', side_effect=transient_failure):
                    supervisor.stop_worker(child, root / 'missing-state.json', grace=.2)
                self.assertGreaterEqual(calls, 2)
                self.assertIsNotNone(child.poll())
                self.assertTrue(child.breezer_cleanup_complete)
                deadline = time.monotonic() + 2
                while driver in actual_table() and time.monotonic() < deadline:
                    time.sleep(.01)
                with self.assertRaises(ProcessLookupError):
                    os.kill(driver, 0)
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=3)
                if driver is not None:
                    try:
                        os.killpg(driver, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
