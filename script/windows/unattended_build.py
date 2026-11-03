#!/usr/bin/env python3
"""Supervise the prepared PC worker without changing its source or build graph."""

import argparse
from collections import deque
import ctypes
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import threading
import time

PROGRESS = re.compile(r'^\[(\d+)/(\d+)\]')


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


class Checkpoints:
    def __init__(self, output, worker, interval=10000):
        self.output = output
        self.directory = output / '.breezer-checkpoints'
        self.directory.mkdir(exist_ok=True)
        self.path = self.directory / 'unattended-state.json'
        old = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.state = {'schema': 1, 'pid': os.getpid(), 'startedAt': utc_now(),
                      'output': str(output), 'workerSha256': digest(worker),
                      'totalObservedActions': old.get('totalObservedActions', 0),
                      'checkpointInterval': interval, 'attempt': 0, 'retries': 0,
                      'countsIncludeFailedActions': True,
                      'workerCommand': [sys.executable, str(worker), '--resume-build-graph']}
        self.interval = interval
        self.next_checkpoint = (self.state['totalObservedActions'] // interval + 1) * interval
        self.pass_finished = 0
        self.last_save = 0
        self.errors = deque(maxlen=30)
        self.action_failed = False
        # Identity is diagnostic. The existing worker still enforces pinned inputs.
        self.state['buildInputs'] = {name: digest(output / name)
                                     for name in ('args.gn', 'build.ninja')
                                     if (output / name).is_file()}

    def save(self, phase, **extra):
        self.state.update(phase=phase, updatedAt=utc_now(), **extra)
        atomic_json(self.path, self.state)
        self.last_save = time.monotonic()

    def consume(self, line):
        if line.startswith('BREEZER_BUILD_PASS '):
            self.pass_finished = 0
            self.state['pass'] = line.strip()
        match = PROGRESS.match(line)
        if match:
            finished, total = map(int, match.groups())
            self.state['totalObservedActions'] += max(0, finished - self.pass_finished)
            self.pass_finished = finished
            self.state.update(passFinishedActions=finished, passTotalActions=total)
            if self.state['totalObservedActions'] >= self.next_checkpoint:
                self.checkpoint()
        if line.startswith('FAILED:'):
            self.action_failed = True
        if re.search(r'FAILED:|fatal error:|ninja: (error|build stopped)|Traceback|RuntimeError:', line):
            self.errors.append(line.strip()[:4000])

    def checkpoint(self):
        # Ninja records finished actions incrementally. Flush the filesystem too;
        # this is an in-place resume point, not another copy of the object tree.
        os.sync()
        self.state['ninjaLogs'] = {name: {'bytes': (self.output / name).stat().st_size,
                                        'sha256': digest(self.output / name)}
                                   for name in ('.ninja_log', '.ninja_deps')
                                   if (self.output / name).is_file()}
        self.save('running', checkpointAtActions=self.state['totalObservedActions'])
        name = f"checkpoint-{self.state['totalObservedActions']:012d}.json"
        atomic_json(self.directory / name, self.state)
        print('BREEZER_BUILD_CHECKPOINT ' + str(self.state['totalObservedActions']), flush=True)
        self.next_checkpoint = (self.state['totalObservedActions'] // self.interval + 1) * self.interval


def stream_lines(stream, lines):
    try:
        while line := stream.readline(65536):
            lines.put(line)
    finally:
        lines.put(None)


def process_table():
    rows = subprocess.check_output(['ps', '-eo', 'pid=,ppid=,pgid=,stat='], text=True, timeout=5)
    return {int(pid): (int(parent), int(group), status)
            for pid, parent, group, status in (row.split() for row in rows.splitlines())}


def descendants(table, root):
    owned = {root}
    while True:
        found = {pid for pid, (parent, _, _) in table.items() if parent in owned}
        if found.issubset(owned):
            return owned
        owned.update(found)


def enable_subreaper():
    # Linux reparents a killed worker's detached Ninja to this supervisor,
    # including a crash before driverPid reaches the worker's state file.
    if sys.platform.startswith('linux'):
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise OSError(ctypes.get_errno(), 'Cannot own detached build children')


def stop_worker(child, worker_state, grace=15):
    if getattr(child, 'breezer_cleanup_complete', False):
        return
    known = getattr(child, 'breezer_cleanup_groups', {})
    child.breezer_cleanup_groups = known
    recheck_ownership = bool(known)

    def snapshot():
        nonlocal recheck_ownership
        for attempt in range(3):
            try:
                table = process_table()
                break
            except (OSError, ValueError, subprocess.SubprocessError):
                if attempt == 2:
                    raise
                time.sleep(.05)
        for group, members in list(known.items()):
            live = {pid for pid, (_, pgid, status) in table.items()
                    if pgid == group and not status.startswith('Z')}
            if recheck_ownership and live and not live.intersection(members):
                raise RuntimeError('Cannot reconfirm compiler group ownership; no retry permitted')
            if live:
                known[group] = live
            else:
                del known[group]
        recheck_ownership = False
        return table

    try:
        if child.poll() is None:
            try:
                os.kill(child.pid, signal.SIGSTOP)
            except ProcessLookupError:
                pass
        # Freeze before discovery so no detached driver escapes the snapshot.
        deadline = time.monotonic() + 2
        while True:
            table = snapshot()
            worker = table.get(child.pid)
            if not worker or worker[2].startswith(('T', 'Z')):
                break
            if time.monotonic() >= deadline:
                child.terminate()
                try:
                    os.kill(child.pid, signal.SIGCONT)
                except ProcessLookupError:
                    pass
                break
            time.sleep(.02)
        owned = descendants(table, child.pid)
        if sys.platform.startswith('linux'):
            owned.update(descendants(table, os.getpid()) - {os.getpid()})
        groups = {table[pid][1] for pid in owned if pid in table}
        if worker_state.exists():
            try:
                state = json.loads(worker_state.read_text())
            except (OSError, ValueError):
                state = {}
            driver = state.get('driverPid')
            if state.get('pid') == child.pid and driver in table and table[driver][1] == driver:
                groups.add(driver)
        groups.discard(os.getpgrp())
        for group in groups:
            members = {pid for pid, (_, pgid, status) in table.items()
                       if pgid == group and not status.startswith('Z')}
            if members:
                known[group] = members
        if child.poll() is None:
            # Queue termination before resuming the owned worker.
            child.terminate()
            try:
                os.kill(child.pid, signal.SIGCONT)
            except ProcessLookupError:
                pass
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
            snapshot()
            for group in list(known):
                try:
                    os.killpg(group, signum)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    snapshot()
                    if group in known:
                        raise
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                snapshot()
                if not known:
                    break
                time.sleep(.05)
            else:
                continue
            break
        child.wait(timeout=grace)
        if sys.platform.startswith('linux'):
            while True:
                try:
                    if os.waitpid(-1, os.WNOHANG)[0] == 0:
                        break
                except ChildProcessError:
                    break
        snapshot()
        if known:
            raise RuntimeError('Owned compiler group survived termination; no retry permitted')
        child.breezer_cleanup_complete = True
    except Exception:
        # Discovery can fail after SIGSTOP. Do not strand a frozen worker or
        # call cleanup complete; the caller's finally may retry known groups.
        if child.poll() is None:
            try:
                child.terminate()
            except ProcessLookupError:
                pass
            try:
                os.kill(child.pid, signal.SIGCONT)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                child.kill()
                try:
                    os.kill(child.pid, signal.SIGCONT)
                except ProcessLookupError:
                    pass
                child.wait(timeout=grace)
        raise


def run(args):
    output = args.output.resolve(strict=True)
    worker = args.worker.resolve(strict=True)
    enable_subreaper()
    checkpoints = Checkpoints(output, worker, args.checkpoint_interval)
    lock = (output / '.breezer-unattended.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('An unattended runner already owns this output') from None
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True

    prior_handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    child = None
    checkpoints.state['resumeCommand'] = [sys.executable, str(Path(__file__).resolve()),
        '--worker', str(worker), '--worker-state', str(args.worker_state.resolve()),
        '--output', str(output), '--checkpoint-interval', str(args.checkpoint_interval),
        '--max-retries', str(args.max_retries), '--retry-delay', str(args.retry_delay),
        '--stop-grace', str(args.stop_grace)]
    try:
        for attempt in range(args.max_retries + 1):
            if stopping:
                break
            checkpoints.pass_finished = 0
            checkpoints.errors.clear()
            checkpoints.action_failed = False
            checkpoints.save('starting', attempt=attempt + 1, retries=attempt, workerOutputClosed=False)
            child = subprocess.Popen([sys.executable, '-u', str(worker), '--resume-build-graph'],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, errors='replace', start_new_session=True)
            lines = queue.Queue(maxsize=128)
            reader = threading.Thread(target=stream_lines, args=(child.stdout, lines), daemon=True)
            reader.start()
            while True:
                if stopping or child.poll() is not None:
                    stop_worker(child, args.worker_state, args.stop_grace)
                try:
                    line = lines.get(timeout=1)
                except queue.Empty:
                    if child.poll() is not None:
                        stop_worker(child, args.worker_state, args.stop_grace)
                    line = ''
                if line is None:
                    checkpoints.save('stopping' if stopping else 'running', workerOutputClosed=True)
                    while child.poll() is None:
                        if stopping:
                            stop_worker(child, args.worker_state, args.stop_grace)
                        if time.monotonic() - checkpoints.last_save >= 5:
                            checkpoints.save('stopping' if stopping else 'running')
                        time.sleep(.1)
                    break
                if line:
                    print(line, end='', flush=True)
                    checkpoints.consume(line)
                if time.monotonic() - checkpoints.last_save >= 5:
                    checkpoints.save('stopping' if stopping else 'running')
            code = child.wait()
            reader.join(timeout=5)
            child.stdout.close()
            stop_worker(child, args.worker_state, args.stop_grace)
            if stopping:
                break
            if code == 0 and not checkpoints.action_failed:
                checkpoints.checkpoint()
                checkpoints.save('completed', workerExitCode=0)
                return 0
            state = json.loads(args.worker_state.read_text()) if args.worker_state.exists() else {}
            owned_state = state.get('pid') == child.pid
            recoverable = not checkpoints.action_failed and (code == -signal.SIGKILL or (
                owned_state and state.get('phase') == 'resource-limited'
                and str(state.get('reason', '')).startswith('Build paused:')))
            if not recoverable or attempt == args.max_retries:
                checkpoints.save('failed', workerExitCode=code, errors=list(checkpoints.errors),
                                 reason=state.get('reason') if owned_state else 'Worker exited unexpectedly',
                                 outputsPreserved=True, retryLimitReached=recoverable)
                return 1
            checkpoints.save('cooldown', workerExitCode=code, outputsPreserved=True)
            deadline = time.monotonic() + args.retry_delay
            while time.monotonic() < deadline and not stopping:
                time.sleep(min(1, max(0, deadline - time.monotonic())))
        checkpoints.checkpoint()
        checkpoints.save('stopped', outputsPreserved=True)
        return 130
    except Exception as error:
        checkpoints.save('failed', reason=str(error), outputsPreserved=True, errors=list(checkpoints.errors))
        raise
    finally:
        try:
            if child is not None:
                stop_worker(child, args.worker_state, args.stop_grace)
        finally:
            try:
                for sig, handler in prior_handlers.items():
                    signal.signal(sig, handler)
            finally:
                lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', type=Path, required=True)
    parser.add_argument('--worker-state', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--checkpoint-interval', type=int, default=10000)
    parser.add_argument('--max-retries', type=int, default=3)
    parser.add_argument('--retry-delay', type=float, default=300)
    parser.add_argument('--stop-grace', type=float, default=15)
    args = parser.parse_args()
    if args.checkpoint_interval < 1 or not 0 <= args.max_retries <= 10 or args.retry_delay < 0 or args.stop_grace <= 0:
        parser.error('Use positive interval/stop grace, 0..10 retries and nonnegative retry delay')
    return run(args)


if __name__ == '__main__':
    sys.exit(main())
