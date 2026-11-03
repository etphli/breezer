"""Exercise the unattended supervisor with real Ninja and disposable workers."""
import json
import importlib.util
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(os.environ.get('BREEZER_SUPERVISOR_SCRIPT', ROOT / 'script/windows/unattended_build.py'))


@unittest.skipUnless(shutil.which('ninja'), 'Ninja required')
class UnattendedBuildTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='breezer-unattended-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.output = self.directory / 'out'
        self.output.mkdir()
        self.worker = self.directory / 'worker.py'
        self.worker_state = self.directory / 'worker.json'
        self.args = [sys.executable, str(SCRIPT), '--worker', str(self.worker),
                     '--worker-state', str(self.worker_state), '--output', str(self.output),
                     '--retry-delay', '0', '--checkpoint-interval', '2', '--stop-grace', '.2']

    def worker_text(self, body):
        self.worker.write_text('import os,json,sys,signal,subprocess,time\nfrom pathlib import Path\n'
                               + f'root=Path({str(self.directory)!r})\nout=root/"out"\n'
                               + 'count=root/"attempts"\n'
                               + 'attempt=int(count.read_text())+1 if count.exists() else 1\n'
                               + 'count.write_text(str(attempt))\n' + body)

    def run_build(self, timeout=45):
        return subprocess.run(self.args, capture_output=True, text=True, timeout=timeout)

    def state(self):
        return json.loads((self.output / '.breezer-checkpoints/unattended-state.json').read_text())

    def test_real_ninja_continues_after_failure_and_resumes_completed_outputs(self):
        (self.output / 'build.ninja').write_text(
            'rule ok\n  command = touch $out\n'
            'rule fail\n  command = test -f allow-success && touch $out\n'
            'build independent-a: ok\nbuild bad: fail\nbuild independent-b: ok\n'
            'default independent-a bad independent-b\n')
        self.worker_text('print("BREEZER_BUILD_PASS {}",flush=True)\n'
                         'sys.exit(subprocess.call(["ninja","-C",str(out),"-j1","-k0"],'
                         'env=dict(os.environ,NINJA_STATUS="[%f/%t] ")))\n')
        failed = self.run_build()
        self.assertEqual(failed.returncode, 1, failed.stdout + failed.stderr)
        self.assertTrue((self.output / 'independent-b').is_file())
        before = (self.output / 'independent-a').stat().st_mtime_ns
        self.assertEqual((self.directory / 'attempts').read_text(), '1')
        self.assertEqual(self.state()['phase'], 'failed')
        self.assertEqual(self.state()['totalObservedActions'], 3)
        self.assertEqual(len(list((self.output / '.breezer-checkpoints').glob('checkpoint-*.json'))), 1)
        (self.output / 'allow-success').touch()
        resumed = self.run_build()
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual((self.output / 'independent-a').stat().st_mtime_ns, before)
        self.assertEqual(self.state()['totalObservedActions'], 4)
        self.assertEqual(self.state()['phase'], 'completed')

    def test_default_checkpoint_at_ten_thousand_real_actions_survives_interruption(self):
        interval_option = self.args.index('--checkpoint-interval')
        del self.args[interval_option:interval_option + 2]
        edges = ''.join(f'build step-{n:05d}: save\n' for n in range(10000))
        targets = ' '.join(f'step-{n:05d}' for n in range(10000))
        (self.output / 'build.ninja').write_text(
            'rule save\n  command = : > $out\n'
            'rule finish\n  command = while [ ! -f allow-finish ]; do sleep 0.1; done; : > $out\n'
            + edges + 'build saved: phony ' + targets
            + '\nbuild step-10000: finish || saved\ndefault step-10000\n')
        self.worker_text('print("BREEZER_BUILD_PASS {}",flush=True)\n'
                         'child=subprocess.Popen(["ninja","-C",str(out),"-j4","-k0"],'
                         'env=dict(os.environ,NINJA_STATUS="[%f/%t] "),start_new_session=True)\n'
                         '(root/"worker.json").write_text(json.dumps({"pid":os.getpid(),"driverPid":child.pid}))\n'
                         'sys.exit(child.wait())\n')
        log_path = self.directory / 'interrupted-build.log'
        with log_path.open('w') as log:
            first = subprocess.Popen(self.args, stdout=log, stderr=subprocess.STDOUT, text=True)
            def stop_fixture():
                if first.poll() is None:
                    first.send_signal(signal.SIGTERM)
                    first.wait(timeout=15)
            self.addCleanup(stop_fixture)
            checkpoint = self.output / '.breezer-checkpoints/checkpoint-000000010000.json'
            deadline = time.monotonic() + 180
            while not checkpoint.exists() and first.poll() is None and time.monotonic() < deadline:
                time.sleep(.05)
            self.assertTrue(checkpoint.exists(), log_path.read_text())
            self.assertIsNone(first.poll(), 'The last action must still be waiting when the checkpoint lands')
            saved = json.loads(checkpoint.read_text())
            self.assertEqual(saved['totalObservedActions'], 10000)
            self.assertEqual(saved['checkpointAtActions'], 10000)
            self.assertEqual(saved['checkpointInterval'], 10000)
            self.assertIn('.ninja_log', saved['ninjaLogs'])
            journaled = {line.split('\t')[3] for line in (self.output / '.ninja_log').read_text().splitlines()
                         if len(line.split('\t')) == 5}
            self.assertEqual(journaled, {f'step-{n:05d}' for n in range(10000)})
            before = {path.name: path.stat().st_mtime_ns for path in self.output.glob('step-*')}
            self.assertEqual(len(before), 10000)
            first.send_signal(signal.SIGTERM)
            first.wait(timeout=15)
        self.assertEqual(first.returncode, 130, log_path.read_text())
        self.assertEqual(self.state()['phase'], 'stopped')
        paused_actions = self.state()['totalObservedActions']
        (self.output / 'allow-finish').touch()
        resumed = self.run_build(timeout=180)
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)
        self.assertEqual(self.state()['phase'], 'completed')
        self.assertEqual(self.state()['totalObservedActions'], paused_actions + 1)
        self.assertEqual(len(list(self.output.glob('step-*'))), 10001)
        self.assertEqual(before, {name: (self.output / name).stat().st_mtime_ns for name in before})
        complete = {path.name: path.stat().st_mtime_ns for path in self.output.glob('step-*')}
        no_op = self.run_build(timeout=180)
        self.assertEqual(no_op.returncode, 0, no_op.stdout + no_op.stderr)
        self.assertIn('no work to do', no_op.stdout)
        self.assertEqual(complete, {path.name: path.stat().st_mtime_ns for path in self.output.glob('step-*')})


    def test_resource_failure_retries_but_stops_at_limit(self):
        self.worker_text('state={"pid":os.getpid(),"phase":"resource-limited","reason":"Build paused: fixture pressure"}\n'
                         '(root/"worker.json").write_text(json.dumps(state))\nsys.exit(1)\n')
        result = self.run_build()
        self.assertEqual(result.returncode, 1)
        self.assertEqual((self.directory / 'attempts').read_text(), '4')
        self.assertTrue(self.state()['retryLimitReached'])

    def test_recovery_can_succeed_after_one_resource_interruption(self):
        self.worker_text('state={"pid":os.getpid(),"phase":"resource-limited" if attempt==1 else "built-unverified-on-mac","reason":"Build paused: fixture pressure"}\n'
                         '(root/"worker.json").write_text(json.dumps(state))\nsys.exit(1 if attempt==1 else 0)\n')
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state()['retries'], 1)
        self.assertEqual(self.state()['phase'], 'completed')

    def test_freeze_timeout_still_terminates_a_driver_without_state(self):
        self.worker_text('child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],start_new_session=True)\n'
                         '(root/"driver-pid").write_text(str(child.pid))\n'
                         'sys.exit(child.wait())\n')
        child = subprocess.Popen([sys.executable, str(self.worker)], start_new_session=True,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: child.kill() if child.poll() is None else None)
        deadline = time.monotonic() + 10
        while not (self.directory / 'driver-pid').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        driver = int((self.directory / 'driver-pid').read_text())
        spec = importlib.util.spec_from_file_location('supervisor', SCRIPT)
        supervisor = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(supervisor)
        actual_table = supervisor.process_table
        actual_clock = time.monotonic
        clock_calls = 0
        table_calls = 0
        def report_unfrozen():
            nonlocal table_calls
            table_calls += 1
            table = actual_table()
            if table_calls == 1 and child.pid in table:
                parent, group, status = table[child.pid]
                table[child.pid] = (parent, group, 'R')
            return table
        def advance_deadline():
            nonlocal clock_calls
            clock_calls += 1
            return actual_clock() + (3 if clock_calls > 1 else 0)
        with patch.object(supervisor, 'process_table', side_effect=report_unfrozen), patch.object(supervisor.time, 'monotonic', side_effect=advance_deadline):
            supervisor.stop_worker(child, self.worker_state, grace=.2)
        self.assertIsNotNone(child.poll())
        deadline = time.monotonic() + 2
        while driver in actual_table() and time.monotonic() < deadline:
            time.sleep(.02)
        with self.assertRaises(ProcessLookupError):
            os.kill(driver, 0)

    def test_logged_failed_action_cannot_be_success_even_with_zero_worker_exit(self):
        self.worker_text('print("FAILED: object.o",flush=True)\n')
        self.assertEqual(self.run_build().returncode, 1)
        self.assertEqual(self.state()['phase'], 'failed')
        self.assertEqual((self.directory / 'attempts').read_text(), '1')

    def test_manual_stop_still_works_after_a_live_worker_closes_its_output(self):
        self.worker_text('os.close(1)\nos.close(2)\n'
                         '(root/"closed-output").write_text(str(os.getpid()))\n'
                         'time.sleep(60)\n')
        runner = subprocess.Popen(self.args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        worker = None
        timed_out = False
        try:
            deadline = time.monotonic() + 10
            while not (self.directory / 'closed-output').exists() and time.monotonic() < deadline:
                time.sleep(.02)
            worker = int((self.directory / 'closed-output').read_text())
            runner.send_signal(signal.SIGTERM)
            try:
                stdout, stderr = runner.communicate(timeout=4)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(worker, signal.SIGKILL)
                stdout, stderr = runner.communicate(timeout=5)
            self.assertFalse(timed_out, 'Stop was stuck waiting for a worker whose output had closed')
            self.assertEqual(runner.returncode, 130, stdout + stderr)
            self.assertEqual(self.state()['phase'], 'stopped')
            self.assertEqual((self.directory / 'attempts').read_text(), '1')
            with self.assertRaises(ProcessLookupError):
                os.kill(worker, 0)
        finally:
            if worker:
                try:
                    os.killpg(worker, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if runner.poll() is None:
                runner.kill()
            runner.communicate(timeout=5)

    def run_stop_fixture(self, child_code, publish_state):
        driver_script = self.directory / 'driver.py'
        driver_script.write_text('import os,signal,time\nfrom pathlib import Path\n'
                                 + child_code + '\n'
                                 + f'Path({str(self.directory / "driver-ready")!r}).write_text(str(os.getpid()))\n'
                                 + 'time.sleep(60)\n')
        self.worker_text('child=subprocess.Popen([sys.executable,str(root/"driver.py")],start_new_session=True)\n'
                         + ('(root/"worker.json").write_text(json.dumps({"pid":os.getpid(),"driverPid":child.pid}))\n' if publish_state else '')
                         + 'sys.exit(child.wait())\n')
        first = subprocess.Popen(self.args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: first.kill() if first.poll() is None else None)
        deadline = time.monotonic() + 10
        while not (self.directory / 'driver-ready').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        driver = int((self.directory / 'driver-ready').read_text())
        def cleanup_driver():
            try:
                os.killpg(driver, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.addCleanup(cleanup_driver)
        first.send_signal(signal.SIGTERM)
        stdout, stderr = first.communicate(timeout=10)
        self.assertEqual(first.returncode, 130, stdout + stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(driver, 0)
        self.assertEqual(self.state()['phase'], 'stopped')

    def test_stop_before_driver_state_is_published_cleans_detached_group(self):
        self.run_stop_fixture('', publish_state=False)

    def test_stubborn_driver_is_terminated_without_leaving_worker_alive(self):
        self.run_stop_fixture('signal.signal(signal.SIGINT,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN)', publish_state=True)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux subreaper requires the PC/WSL environment')
    def test_killed_worker_before_state_write_does_not_orphan_driver(self):
        self.worker_text('if attempt==1:\n'
                         '    child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],start_new_session=True)\n'
                         '    (root/"driver-pid").write_text(str(child.pid))\n'
                         '    os.kill(os.getpid(),signal.SIGKILL)\n')
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        driver = int((self.directory / 'driver-pid').read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(driver, 0)
        self.assertEqual(self.state()['retries'], 1)

    def test_compiler_failure_after_paging_backoff_does_not_retry(self):
        self.worker_text('state={"pid":os.getpid(),"phase":"resource-limited","reason":"Full browser build driver exited 1"}\n'
                         '(root/"worker.json").write_text(json.dumps(state))\n'
                         'print("FAILED: object.o",flush=True)\nsys.exit(1)\n')
        self.assertEqual(self.run_build().returncode, 1)
        self.assertEqual((self.directory / 'attempts').read_text(), '1')

    def test_stale_resource_state_does_not_retry_a_compiler_failure(self):
        self.worker_state.write_text(json.dumps({'pid': 0, 'phase': 'resource-limited'}))
        self.worker_text('sys.exit(1)\n')
        self.assertEqual(self.run_build().returncode, 1)
        self.assertEqual((self.directory / 'attempts').read_text(), '1')

    def test_manual_stop_cleans_up_a_separate_ninja_group(self):
        (self.output / 'build.ninja').write_text(
            'rule slow\n  command = ' + sys.executable + ' -c "import time; time.sleep(60)"\n'
            'build slow-output: slow\ndefault slow-output\n')
        self.worker_text('child=subprocess.Popen(["ninja","-C",str(out),"-k0"],start_new_session=True)\n'
                         '(root/"worker.json").write_text(json.dumps({"pid":os.getpid(),"driverPid":child.pid}))\n'
                         'sys.exit(child.wait())\n')
        first = subprocess.Popen(self.args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: first.kill() if first.poll() is None else None)
        deadline = time.monotonic() + 10
        while not self.worker_state.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        driver = json.loads(self.worker_state.read_text())['driverPid']
        first.send_signal(signal.SIGTERM)
        stdout, stderr = first.communicate(timeout=15)
        self.assertEqual(first.returncode, 130, stdout + stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(driver, 0)
        self.assertEqual((self.directory / 'attempts').read_text(), '1')

    def test_manual_stop_does_not_restart_and_lock_rejects_another_runner(self):
        self.worker_text('while True: time.sleep(.05)\n')
        first = subprocess.Popen(self.args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: first.kill() if first.poll() is None else None)
        deadline = time.monotonic() + 10
        while not (self.directory / 'attempts').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        second = self.run_build()
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('already owns', second.stderr)
        first.send_signal(signal.SIGTERM)
        stdout, stderr = first.communicate(timeout=10)
        self.assertEqual(first.returncode, 130, stdout + stderr)
        self.assertEqual(self.state()['phase'], 'stopped')
        self.assertEqual((self.directory / 'attempts').read_text(), '1')


if __name__ == '__main__':
    unittest.main()
