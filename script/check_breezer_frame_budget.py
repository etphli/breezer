#!/usr/bin/env python3
"""Offline functional fixtures only. Never runs the complete build pipeline."""
import argparse
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CLI = HERE / 'apply_breezer_frame_budget.py'
spec = importlib.util.spec_from_file_location('frame_budget', CLI)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
RECORDS = []


def run(command, **kwargs):
    result = subprocess.run([str(value) for value in command], text=True, capture_output=True,
                            timeout=20, **kwargs)
    RECORDS.append(dict(command=[str(v) for v in command], returncode=result.returncode,
                        stdout=result.stdout, stderr=result.stderr))
    return result


def snapshot(root):
    result = {}
    for p in root.rglob('*'):
        s = p.lstat()
        result[str(p.relative_to(root))] = (s.st_mode, s.st_nlink, s.st_ino, s.st_mtime_ns,
                                           os.readlink(p) if p.is_symlink() else
                                           module.digest(p.read_bytes()) if p.is_file() else None)
    return result


def block(name):
    text = (HERE / 'build_and_run.sh').read_text()
    return text.split('# BEGIN frame-budget ' + name + '\n')[1].split('# END frame-budget ' + name)[0]


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='case-', dir=WORK))
        self.tree = self.root / 'stage/build/src'
        for name in module.NAMES:
            dest = self.tree / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE / name, dest)
            dest.chmod(0o640)
        (self.tree / 'out').mkdir()
        (self.tree / 'out/retained').write_bytes(b'compiled-cache-sentinel')
        (self.root / 'stage/build/.breezer-prepared').write_text('fixture-existing-preparation\n')

    def cli(self, *args, good=True, script=CLI):
        result = run([sys.executable, '-B', script, *args])
        self.assertEqual(result.returncode == 0, good, result.stderr)
        return result

    def apply(self):
        return self.cli('--private-quiescent-copy', self.tree)

    def rejection(self, *args, script=CLI):
        before = snapshot(self.root)
        self.cli(*args, good=False, script=script)
        self.assertEqual(snapshot(self.root), before)

    def test_cli_apply_check_fingerprint_and_repeat(self):
        fingerprint = self.cli('--fingerprint').stdout.strip()
        self.assertEqual(len(fingerprint), 64)
        self.rejection('--check', self.tree)
        self.rejection(self.tree)
        self.cli('--preflight', self.tree)
        self.apply()
        self.cli('--check', self.tree)
        before = snapshot(self.root)
        self.apply()
        self.assertEqual(snapshot(self.root), before)
        self.assertEqual((self.tree / module.MARKER).read_text(), fingerprint + '\n')
        for name in module.NAMES:
            self.assertEqual(module.digest((self.tree / name).read_bytes()), PINS[name]['after_sha256'])
        self.assertEqual((self.tree / 'out/retained').read_bytes(), b'compiled-cache-sentinel')

    def test_all_mixed_inputs_resume(self):
        for bits in itertools.product((False, True), repeat=2):
            with self.subTest(bits=bits):
                (self.tree / module.MARKER).unlink(missing_ok=True)
                for name in module.NAMES:
                    shutil.copyfile(SOURCE / name, self.tree / name)
                for name, applied in zip((module.NAMES[0], module.NAMES[2]), bits):
                    if applied:
                        shutil.copyfile(ROOT / module.DATA / 'payload' / name, self.tree / name)
                self.apply()
                self.cli('--check', self.tree)

    def test_unknown_each_input_and_marked_base_reject_before_write(self):
        for name in module.NAMES:
            with self.subTest(name=name):
                path = self.tree / name
                data = path.read_bytes()
                path.write_bytes(b'unknown later input\n')
                self.rejection('--private-quiescent-copy', self.tree)
                path.write_bytes(data)
        self.apply()
        shutil.copyfile(SOURCE / module.NAMES[0], self.tree / module.NAMES[0])
        self.rejection('--preflight', self.tree)
        self.rejection('--check', self.tree)

    def test_marker_and_fingerprint_drift(self):
        self.apply()
        marker = self.tree / module.MARKER
        marker.write_text('stale\n')
        self.rejection('--private-quiescent-copy', self.tree)
        marker.write_text(module.fingerprint() + '\n')
        altered = self.root / 'repo'
        shutil.copytree(ROOT / 'features', altered / 'features')
        (altered / 'script').mkdir()
        shutil.copyfile(CLI, altered / 'script' / CLI.name)
        changed_cli = altered / 'script' / CLI.name
        for relative in ('script/' + CLI.name, str(module.DATA / 'pins.json'),
                         str(module.DATA / 'payload' / module.NAMES[-1])):
            path = altered / relative
            original = path.read_bytes()
            path.write_bytes(original + b'\n')
            drift = self.cli('--fingerprint', script=changed_cli).stdout.strip()
            self.assertNotEqual(drift, module.fingerprint())
            self.rejection('--preflight', self.tree, script=changed_cli)
            path.write_bytes(original)

    def test_invalid_targets(self):
        for name in module.NAMES:
            path = self.tree / name
            data = path.read_bytes()
            for kind in ('missing', 'symlink', 'hardlink', 'directory'):
                with self.subTest(name=name, kind=kind):
                    path.unlink()
                    saved = self.root / 'saved'
                    saved.write_bytes(data)
                    if kind == 'symlink': path.symlink_to(saved)
                    if kind == 'hardlink': os.link(saved, path)
                    if kind == 'directory': path.mkdir()
                    self.rejection('--private-quiescent-copy', self.tree)
                    if path.is_dir(): path.rmdir()
                    elif os.path.lexists(path): path.unlink()
                    saved.unlink()
                    path.write_bytes(data)
        linked = self.root / 'linked'
        linked.symlink_to(self.tree, target_is_directory=True)
        self.rejection('--private-quiescent-copy', linked)

    def test_payload_later_drift_preflight(self):
        altered = self.root / 'repo'
        shutil.copytree(ROOT / 'features', altered / 'features')
        (altered / 'script').mkdir()
        shutil.copyfile(CLI, altered / 'script' / CLI.name)
        payload = altered / module.DATA / 'payload' / module.NAMES[-1]
        payload.write_bytes(b'bad payload')
        self.rejection('--private-quiescent-copy', self.tree, script=altered / 'script' / CLI.name)

    def test_fdopen_failure_closes_owned_descriptor_and_retry(self):
        original = module.tempfile.mkstemp
        descriptors = []
        def capture(*a, **kw):
            fd, name = original(*a, **kw)
            descriptors.append(fd)
            return fd, name
        with mock.patch.object(module.tempfile, 'mkstemp', capture), mock.patch.object(
                module.os, 'fdopen', side_effect=OSError('injected fdopen failure')):
            with self.assertRaisesRegex(OSError, 'injected fdopen'):
                module.apply(self.tree, private=True)
        for fd in descriptors:
            with self.assertRaises(OSError): os.fstat(fd)
        self.assertFalse((self.tree / module.MARKER).exists())
        orphans = {p: p.read_bytes() for p in self.tree.rglob('*.tmp')}
        self.apply()
        self.assertEqual({p: p.read_bytes() for p in orphans}, orphans)

    def test_preparing_marker_validation_and_default_fence(self):
        intent = self.tree / module.PREPARING
        intent.write_text('stale\n')
        self.rejection('--preflight', self.tree)
        self.assertNotEqual(self.shell().returncode, 0)
        intent.unlink()
        intent.symlink_to(self.root / 'missing-intent')
        self.rejection('--private-quiescent-copy', self.tree)
        self.assertNotEqual(self.shell().returncode, 0)
        intent.unlink()
        intent.write_text(module.fingerprint() + '\n')
        self.cli('--preflight', self.tree)
        self.rejection('--check', self.tree)
        self.assertNotEqual(self.shell().returncode, 0)
        self.apply()
        self.assertFalse(intent.exists())
        self.cli('--check', self.tree)

    def test_owned_process_interruptions(self):
        for point in ('preparing-before', 'preparing-after', 'source-before', 'source-after', 'marker-before', 'marker-after'):
            with self.subTest(point=point):
                (self.tree / module.MARKER).unlink(missing_ok=True)
                for name in module.NAMES:
                    shutil.copyfile(SOURCE / name, self.tree / name)
                result = run([sys.executable, '-B', __file__, '--interrupt', point, str(self.tree)])
                self.assertEqual(result.returncode, -signal.SIGKILL)
                if point != 'marker-after': self.assertFalse((self.tree / module.MARKER).exists())
                orphans = {p: p.read_bytes() for p in self.tree.rglob('*.tmp')}
                self.apply()
                self.cli('--check', self.tree)
                self.assertFalse((self.tree / module.PREPARING).exists())
                self.assertEqual({p: p.read_bytes() for p in orphans}, orphans)

    def shell(self, opt=None, ack='1', mode='--build-only', which='preflight', stage=None):
        env = dict(os.environ)
        for name in ('BREEZER_FRAME_BUDGET_EXPERIMENT', 'BREEZER_FRAME_BUDGET_PRIVATE_COPY'):
            env.pop(name, None)
        env.update(BREEZER_ROOT=str(ROOT), BREEZER_STAGE=str(stage or self.root / 'stage'),
                   BREEZER_PYTHON=sys.executable, BREEZER_MODE=mode,
                   BREEZER_FRAME_BUDGET_PRIVATE_COPY=ack, _src_dir=str(self.tree))
        if opt is not None: env['BREEZER_FRAME_BUDGET_EXPERIMENT'] = opt
        return run(['bash', '-euxc', block(which) + '\nprintf "fixture-next-command\\n"'], env=env)

    def test_default_source_guard_and_command_trace(self):
        for opt in (None, '0'):
            for which in ('preflight', 'preparation'):
                result = self.shell(opt, which=which)
                self.assertEqual(result.returncode, 0, result.stderr)
                if which == 'preflight':
                    self.assertEqual(result.stdout, 'No known frame-budget experimental source detected.\nfixture-next-command\n')
                    self.assertIn('--guard-default', result.stderr)
                else:
                    self.assertEqual(result.stdout, 'fixture-next-command\n')
                    self.assertNotIn('apply_breezer_frame_budget.py', result.stderr)
        self.apply()
        before = snapshot(self.root)
        result = self.shell()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('fixture-next-command', result.stdout)
        self.assertEqual(snapshot(self.root), before)

    def test_unmarked_legacy_mixtures_block_default_then_resume(self):
        changed = (module.NAMES[0], module.NAMES[2])
        for bits in ((True, False), (False, True), (True, True)):
            with self.subTest(bits=bits):
                for name, applied in zip(changed, bits):
                    source = ROOT / module.DATA / 'payload' / name if applied else SOURCE / name
                    shutil.copyfile(source, self.tree / name)
                before = snapshot(self.root)
                result = self.shell()
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('fixture-next-command', result.stdout)
                self.assertEqual(snapshot(self.root), before)
        self.apply()
        self.cli('--check', self.tree)
        self.assertEqual((self.tree / 'out/retained').read_bytes(), b'compiled-cache-sentinel')

    def test_default_guard_allows_absent_sources_and_other_versions(self):
        before = snapshot(self.root)
        self.cli('--guard-default', self.root / 'not-prepared')
        self.assertEqual(snapshot(self.root), before)
        alias = self.root / 'source-alias'
        alias.symlink_to(self.tree, target_is_directory=True)
        self.cli('--guard-default', alias)
        name = module.NAMES[0]
        shutil.copyfile(ROOT / module.DATA / 'payload' / name, self.tree / name)
        self.rejection('--guard-default', alias)
        for name in module.NAMES:
            (self.tree / name).write_bytes(b'different upstream version\n')
        before = snapshot(self.root)
        self.cli('--guard-default', self.tree)
        self.assertEqual(snapshot(self.root), before)
        (self.tree / module.PREPARING).write_text('legacy intent\n')
        self.rejection('--guard-default', self.tree)

    def test_shell_unknown_later_source_stops_and_dangling_marker_blocks_default(self):
        path = self.tree / module.NAMES[-1]
        path.write_bytes(b'unknown last native input')
        before = snapshot(self.root)
        result = self.shell('1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('fixture-next-command', result.stdout)
        self.assertEqual(snapshot(self.root), before)
        marker = self.tree / module.MARKER
        marker.symlink_to(self.root / 'missing-marker')
        result = self.shell()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('fixture-next-command', result.stdout)

    def test_all_three_reverified_before_marker(self):
        original = module.os.replace
        def corrupt_header_after_last_source(old, new):
            original(old, new)
            if Path(new).name == 'frame_eviction_manager_unittest.cc':
                (self.tree / module.NAMES[1]).write_bytes(b'injected readback drift')
        with mock.patch.object(module.os, 'replace', corrupt_header_after_last_source):
            with self.assertRaisesRegex(ValueError, 'unknown input'):
                module.apply(self.tree, private=True)
        self.assertFalse((self.tree / module.MARKER).exists())
        self.assertTrue((self.tree / module.PREPARING).exists())
        self.assertNotEqual(self.shell().returncode, 0)
        self.assertEqual((self.tree / 'out/retained').read_bytes(), b'compiled-cache-sentinel')

    def test_real_shell_optin_gates_and_prepare(self):
        for ack, mode in (('0', '--build-only'), ('1', '--install'), ('1', 'run')):
            result = self.shell('1', ack=ack, mode=mode)
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.shell('1').returncode, 0)
        self.assertEqual(self.shell('1', which='preparation').returncode, 0)
        self.cli('--check', self.tree)
        marker = self.tree / module.MARKER
        marker.write_text('stale\n')
        before = snapshot(self.root)
        self.assertNotEqual(self.shell('1').returncode, 0)
        self.assertEqual(snapshot(self.root), before)
        self.assertNotEqual(self.shell('1', stage=ROOT / 'build/helium-macos').returncode, 0)
        marker.unlink()
        (self.root / 'stage/build/.breezer-prepared').unlink()
        self.assertNotEqual(self.shell('1').returncode, 0)

    def test_shared_output_alias_rejected_before_preparation(self):
        output = self.tree / 'out'
        shared = self.root / 'shared-output'
        output.rename(shared)
        output.symlink_to(shared, target_is_directory=True)
        before = snapshot(self.root)
        result = self.shell('1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('fixture-next-command', result.stdout)
        self.assertEqual(snapshot(self.root), before)
        self.assertEqual((shared / 'retained').read_bytes(), b'compiled-cache-sentinel')


def interrupt(point, tree):
    original = module.os.replace
    def replacement(old, new):
        name = Path(new).name
        when = 'marker' if name == module.MARKER else 'preparing' if name == module.PREPARING else 'source'
        if point == when + '-before': os.kill(os.getpid(), signal.SIGKILL)
        original(old, new)
        if point == when + '-after': os.kill(os.getpid(), signal.SIGKILL)
    module.os.replace = replacement
    module.apply(Path(tree), private=True)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--interrupt':
        interrupt(sys.argv[2], sys.argv[3])
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--fixture-source', required=True, type=Path,
                            help='Private directory containing only the three pinned base files')
        parser.add_argument('--work-dir', required=True, type=Path)
        args = parser.parse_args()
        SOURCE = args.fixture_source.resolve()
        WORK = args.work_dir.resolve()
        WORK.mkdir(parents=True, exist_ok=True)
        PINS = json.loads((ROOT / module.DATA / 'pins.json').read_text())['source_files']
        for name in module.NAMES:
            if module.digest((SOURCE / name).read_bytes()) != PINS[name]['before_sha256']:
                parser.error('fixture base hash mismatch: ' + name)
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(Fixtures)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        (WORK / 'commands.json').write_text(json.dumps(RECORDS, indent=2) + '\n')
        sys.exit(not result.wasSuccessful())
