"""Build tooling refusals and rollbacks, exercised in temporary directories.

Nothing here builds, installs, signs or launches Breezer: external commands are
replaced by PATH shims, and HOME points at a temporary directory.
"""
import importlib.util
import json
import os
import re
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'script'))
sys.path.insert(0, str(ROOT / 'script/windows'))
import install_breezer
import package_breezer_ai as packaging
import build_breezer

SCRIPT = (ROOT / 'script/build_and_run.sh').read_text()
GIT_IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false']


def git(directory, *arguments):
    return subprocess.run(['git', *GIT_IDENTITY, *arguments], cwd=directory, check=True,
                          capture_output=True, text=True).stdout


def committed_repo(path, files):
    path.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (path / name).parent.mkdir(parents=True, exist_ok=True)
        (path / name).write_text(content)
    git(path, 'init', '-q')
    git(path, 'add', '.')
    git(path, 'commit', '-q', '-m', 'fixture')
    return path


class Temporary(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='breezer-tooling-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()


def load(path):
    spec = importlib.util.spec_from_file_location(f'fingerprint_{Path(path).stem}_{abs(hash(path))}', ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CheckpointFingerprintTest(unittest.TestCase):
    """Every input behind a prepared-source marker must change the CI checkpoint key."""

    def read_inputs(self, function):
        seen = set()
        original = Path.read_bytes

        def recording(path):
            seen.add(Path(path).resolve().relative_to(ROOT).as_posix())
            return original(path)
        with patch.object(Path, 'read_bytes', recording):
            function()
        return seen

    def test_checkpoint_key_covers_every_prepared_marker_input(self):
        workflow = (ROOT / '.github/workflows/build-breezer-macos.yml').read_text()
        patterns = set()
        for name in ('NATIVE', 'EXTENSION', 'WORKSPACE', 'OMNIBOX'):
            line = re.search(rf'^\s*{name}_INPUT_HASH: \$\{{\{{ hashFiles\((.*)\) \}}\}}$', workflow, re.M)
            self.assertIsNotNone(line, name)
            patterns.update(re.findall(r"'([^']+)'", line[1]))
            self.assertIn(f'steps.inputs.outputs.{name.lower()}', workflow)

        def covered(name):
            return any(name == pattern or (pattern.endswith('/**') and name.startswith(pattern[:-2]))
                       for pattern in patterns)
        inputs = set()
        for script in ('script/apply_breezer_omnibox.py', 'script/apply_breezer_workspace.py',
                       'script/apply_breezer_ai_ui.py', 'features/passwords/native-ui/apply.py',
                       'script/apply_breezer_sync.py', 'features/storage/code-sign-clones/apply.py'):
            with self.subTest(script=script):
                self.assertIn(f'{script}" --fingerprint', SCRIPT)
                found = self.read_inputs(load(script).fingerprint)
                self.assertTrue(found)
                inputs.update(found)
        inputs.update(self.read_inputs(load('script/breezer_preparation.py').ai_source_id))
        base = re.search(r'shasum -a 256 (script/apply_breezer_branding\.py[^\n]*)', SCRIPT)[1].split()
        inputs.update(base)
        inputs.add('script/breezer_preparation.py')
        self.assertIn('git rev-parse HEAD:upstream/helium-macos', SCRIPT)
        inputs.add('upstream/helium-macos/env.sh')
        self.assertEqual(sorted(name for name in inputs if not covered(name)), [])

    def test_refused_checkpoint_is_not_saved(self):
        workflow = (ROOT / '.github/workflows/build-breezer-macos.yml').read_text()
        save = workflow.split('- name: Save compilation progress', 1)[1].split('- name:', 1)[0]
        self.assertIn("steps.compile.outputs.exit_code != '3'", save)
        self.assertIn("steps.compile.outputs.exit_code != ''", save)
        for message in ('Prepared-source marker is missing', 'Omnibox overlay inputs changed',
                        'Signature-clone overlay changed', 'native overlay changed', 'Build inputs changed',
                        'Experimental frame-budget source requires', 'contains the opt-in compiled-list experiment'):
            with self.subTest(message=message):
                after = SCRIPT.split(message, 1)[1]
                self.assertRegex(after[:400], r'\n\s*exit 3\n')
        self.assertRegex(SCRIPT, r'apply_breezer_frame_budget\.py" --guard-default "[^"\n]*" \|\| exit 3\n')


class InstallHoldTest(Temporary):
    def test_hold_in_worktree_or_primary_checkout_blocks_install(self):
        primary = committed_repo(self.root / 'primary', {'README': 'fixture\n'})
        worktree = self.root / 'linked'
        git(primary, 'worktree', 'add', '-q', '--detach', str(worktree))
        install_breezer.check_update_hold(worktree, environ={})
        for holder in (primary, worktree):
            with self.subTest(holder=holder.name):
                hold = holder / 'build/local-update-hold.json'
                hold.parent.mkdir(exist_ok=True)
                hold.write_text(json.dumps({'instruction': 'Wait for an explicit request.'}))
                with self.assertRaisesRegex(ValueError, 'on hold(.|\n)*Wait for an explicit request'):
                    install_breezer.check_update_hold(worktree, environ={})
                install_breezer.check_update_hold(worktree, environ={'BREEZER_OVERRIDE_UPDATE_HOLD': '1'})
                hold.unlink()

    def test_unreadable_hold_still_blocks_and_main_checks_before_download(self):
        repo = committed_repo(self.root / 'repo', {'README': 'fixture\n'})
        (repo / 'build').mkdir()
        (repo / 'build/local-update-hold.json').write_text('not json')
        with self.assertRaisesRegex(ValueError, 'No readable reason'):
            install_breezer.check_update_hold(repo, environ={})
        with patch.object(install_breezer, 'ROOT', repo), \
                patch.object(install_breezer, 'download_artifact') as download, \
                patch.dict(os.environ, {'BREEZER_OVERRIDE_UPDATE_HOLD': ''}), \
                patch.object(sys, 'argv', ['install_breezer.py', '--run-id', '1', '--commit', 'a' * 40]):
            with self.assertRaisesRegex(ValueError, 'on hold'):
                install_breezer.main()
        download.assert_not_called()


class PackageIdentityTest(Temporary):
    def package(self, repo):
        app = self.root / 'Breezer.app'
        shutil.rmtree(app, ignore_errors=True)
        (app / 'Contents').mkdir(parents=True)
        (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(
            {'CFBundleIdentifier': 'io.github.etphli.breezer', 'CFBundleExecutable': 'Breezer'}))
        resources = app / 'Contents/Frameworks/Breezer Framework.framework/Versions/1/Resources'
        resources.mkdir(parents=True)
        feature = repo / 'features/ai'
        with patch.object(packaging, 'ROOT', repo), patch.object(packaging, 'FEATURE', feature), \
                patch.object(packaging, 'release_version', return_value='1.0.0'), \
                patch.object(packaging, 'download_runtime', return_value=repo / 'node.tar.gz'), \
                patch.object(packaging, 'unpack_runtime', side_effect=lambda _a, d, _l: d.mkdir()), \
                patch.object(packaging.platform, 'system', return_value='Linux'):
            target = packaging.package(app, 'arm64', self.root / 'cache')
        return target, json.loads((target / 'host/build-identity.json').read_text())

    def test_untracked_host_files_are_not_shipped_and_dirty_inputs_are_marked(self):
        repo = committed_repo(self.root / 'repo', {
            'features/ai/host/launch.sh': '#!/bin/sh\n', 'features/ai/host/main.mjs': 'export {};\n',
            'features/ai/integration/native-host-manifest.json': '{}',
            'features/ai/runtime.lock.json': json.dumps({'version': '24.0.0', 'distributions': {'arm64': {}}}),
        })
        commit = git(repo, 'rev-parse', 'HEAD').strip()
        target, identity = self.package(repo)
        self.assertEqual(identity, {'commit': commit})
        self.assertTrue(os.access(target / 'host/launch.sh', os.X_OK))

        (repo / 'features/ai/host/scratch.mjs').write_text('local experiment\n')
        target, identity = self.package(repo)
        self.assertFalse((target / 'host/scratch.mjs').exists())
        self.assertEqual(identity, {'commit': commit, 'dirty': True})

        (repo / 'features/ai/host/scratch.mjs').unlink()
        (repo / 'features/ai/host/main.mjs').write_text('export const changed = 1;\n')
        self.assertEqual(self.package(repo)[1], {'commit': commit, 'dirty': True})


class WindowsOverlayMarkerTest(Temporary):
    expected = {'helium': 'h' * 40, 'skipped_patches': []}

    def breezer(self, commit='a' * 40, overlay='1' * 64):
        return {'breezer_commit': commit, 'breezer_overlays': {'script/apply_breezer_sync.py': overlay}}

    def test_changed_overlays_are_not_reapplied_to_a_built_tree(self):
        marker = self.root / 'src' / build_breezer.SOURCE_MARKER
        marker.parent.mkdir()
        build_breezer.write_marker(marker, build_breezer.prepared_marker(self.expected))
        build_breezer.record_overlays(marker, self.expected, self.breezer())
        self.assertEqual(json.loads(marker.read_text()), {**build_breezer.prepared_marker(self.expected), **self.breezer()})
        # A new commit with identical overlay inputs re-applies idempotently.
        build_breezer.record_overlays(marker, self.expected, self.breezer(commit='b' * 40))
        recorded = marker.read_text()
        with self.assertRaisesRegex(ValueError, r'apply_breezer_sync\.py(.|\n)*run prepare again'):
            build_breezer.record_overlays(marker, self.expected, self.breezer(overlay='2' * 64))
        self.assertEqual(marker.read_text(), recorded)
        with self.assertRaisesRegex(ValueError, 'mismatched build inputs'):
            build_breezer.record_overlays(marker, {**self.expected, 'helium': 'x' * 40}, self.breezer())

    def test_trees_prepared_before_overlay_tracking_are_refused(self):
        marker = self.root / 'src' / build_breezer.SOURCE_MARKER
        marker.parent.mkdir()
        # Neither a never-built legacy tree nor one a transitional build recorded
        # can show which overlays it already holds.
        for legacy in (self.expected, {**self.expected, **self.breezer()}):
            with self.subTest(legacy=legacy):
                build_breezer.write_marker(marker, legacy)
                with self.assertRaisesRegex(ValueError, 'older build script(.|\n)*run prepare again'):
                    build_breezer.record_overlays(marker, self.expected, self.breezer())
                self.assertEqual(json.loads(marker.read_text()), legacy)

    def test_package_refuses_a_build_from_another_commit(self):
        lock = build_breezer.load_lock()
        expected = build_breezer.prepared_inputs(lock)
        output = self.root / 'src/out/Default'
        output.mkdir(parents=True)
        current = build_breezer.breezer_inputs()
        self.assertEqual(current['breezer_commit'], git(ROOT, 'rev-parse', 'HEAD').strip())
        sys.path.insert(0, str(ROOT / lock['helium']['path'] / 'utils'))
        for marker, message in (({**expected, **current, 'breezer_commit': 'f' * 40}, 'compiled from Breezer commit f'),
                                ({**expected, **current, 'breezer_overlays': {}}, 'overlay inputs changed'),
                                (expected, 'compiled from Breezer commit unknown')):
            with self.subTest(message=message):
                build_breezer.write_marker(output / build_breezer.BUILD_MARKER, marker)
                with self.assertRaisesRegex(ValueError, message):
                    build_breezer.package_browser(self.root, self.root / 'artifacts', expected)
                self.assertFalse((self.root / 'artifacts').exists())


SHIMS = {
    'ps': 'for exe in $FAKE_RUNNING $(cat "$CALLS/launched" 2>/dev/null); do echo "$UID $exe"; done',
    'osascript': 'cat >/dev/null',
    # A launched app appears in later process listings.
    'open': 'printf "%s\\n" "$*" >> "$CALLS/open"; echo "$2/Contents/MacOS/Breezer" >> "$CALLS/launched"',
    'lldb': 'printf "%s\\n" "$*" >> "$CALLS/lldb"',
    'sleep': ':',
    'uuidgen': 'python3 -c "import uuid; print(str(uuid.uuid4()).upper())"',
    'greadlink': 'shift; [ "$1" = -- ] && shift; python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1"',
    'ditto': '[ -z "$FAKE_DITTO_FAIL" ] || exit 1; cp -R "$1" "$2"',
    'codesign': 'exit "${FAKE_CODESIGN_RC:-0}"',
    # Stands in for /usr/libexec/PlistBuddy -c 'Print :Key' file, so this also runs on Linux CI.
    'PlistBuddy': 'python3 -c "import plistlib,sys; print(plistlib.load(open(sys.argv[2],\'rb\'))[sys.argv[1][7:]])" "$2" "$3"',
}


class BuildAndRunLaunchTest(Temporary):
    def setUp(self):
        super().setUp()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name, body in SHIMS.items():
            (self.bin / name).write_text('#!/bin/bash\n' + body + '\n')
            (self.bin / name).chmod(0o755)
        self.home = self.root / 'home'
        self.project = self.root / 'project'
        self.calls = self.root / 'calls'
        for directory in (self.home / 'Applications', self.project, self.calls):
            directory.mkdir(parents=True)
        self.build = self.app(self.root / 'out/Breezer.app', 'new build')
        self.installed = self.home / 'Applications/Breezer.app'
        self.tail = SCRIPT[SCRIPT.index('# Development launches use a separate profile'):]
        self.tail = self.tail.replace('/usr/libexec/PlistBuddy', 'PlistBuddy')

    def app(self, path, label):
        (path / 'Contents/MacOS').mkdir(parents=True)
        (path / 'Contents/MacOS/Breezer').write_text(label)
        (path / 'Contents/MacOS/Breezer').chmod(0o755)
        (path / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'io.github.etphli.breezer'}))
        return path

    def run_mode(self, mode, **extra):
        env = {'PATH': f'{self.bin}:/usr/bin:/bin', 'HOME': str(self.home), 'CALLS': str(self.calls),
               'BREEZER_MODE': mode, 'BREEZER_ROOT': str(self.project), 'BREEZER_APP': str(self.build),
               'FAKE_RUNNING': '', **extra}
        shell = 'set -euo pipefail\ncheck_install_hold() { :; }\n' + self.tail
        return subprocess.run(['bash', '-c', shell], env=env, capture_output=True, text=True, timeout=60)

    def calls_to(self, name):
        path = self.calls / name
        return path.read_text().splitlines() if path.exists() else []

    def test_development_modes_use_a_separate_profile_beside_a_running_installed_app(self):
        profile = self.project / 'build/dev-profile'
        running = str(self.installed / 'Contents/MacOS/Breezer')
        for mode in ('run', '--verify', '--debug'):
            with self.subTest(mode=mode):
                (self.calls / 'launched').unlink(missing_ok=True)
                result = self.run_mode(mode, FAKE_RUNNING=running)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn('Quit the running Breezer', result.stderr)
                launched = self.calls_to('lldb' if mode == '--debug' else 'open')[-1]
                self.assertIn(f'--user-data-dir={profile}', launched)
                self.assertTrue(profile.is_dir())

    def test_real_profile_is_opt_in_and_keeps_the_running_app_check(self):
        running = str(self.installed / 'Contents/MacOS/Breezer')
        result = self.run_mode('run', BREEZER_USE_REAL_PROFILE='1', FAKE_RUNNING=running)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Quit the running Breezer before launching a build on the same profile', result.stderr)
        result = self.run_mode('run', BREEZER_USE_REAL_PROFILE='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls_to('open'), [f'-n {self.build}'])
        self.assertFalse((self.project / 'build/dev-profile').exists())

    def test_install_keeps_unique_backups_and_the_real_profile(self):
        self.app(self.installed, 'first install')
        for label in ('second', 'third'):
            (self.calls / 'launched').unlink(missing_ok=True)  # The user quit the opened app.
            result = self.run_mode('--install')
            self.assertEqual(result.returncode, 0, result.stderr)
            (self.installed / 'Contents/MacOS/Breezer').write_text(label)
        backups = sorted((self.home / 'Applications/.Breezer-backups').iterdir())
        self.assertEqual(len(backups), 2)
        for backup in backups:
            self.assertRegex(backup.name, r'^Breezer-\d{8}-\d{6}-[0-9a-f]{8}\.app$')
            self.assertEqual(sorted(p.name for p in backup.iterdir()), ['Contents'])
        self.assertEqual({(b / 'Contents/MacOS/Breezer').read_text() for b in backups}, {'first install', 'second'})
        self.assertTrue(all('--user-data-dir' not in call for call in self.calls_to('open')))
        self.assertEqual(self.calls_to('open')[-1], f'-n {self.installed}')

    def test_failed_install_copy_restores_the_previous_app(self):
        self.app(self.installed, 'previous')
        for failure in ({'FAKE_CODESIGN_RC': '1'}, {'FAKE_DITTO_FAIL': '1'}):
            with self.subTest(failure=failure):
                result = self.run_mode('--install', **failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('restoring the previous app', result.stderr)
                self.assertEqual((self.installed / 'Contents/MacOS/Breezer').read_text(), 'previous')
                self.assertEqual(list((self.home / 'Applications/.Breezer-backups').iterdir()), [])
                self.assertEqual(self.calls_to('open'), [])


class BuildAndRunPreparationTest(Temporary):
    def run_preparation(self, stage):
        start = SCRIPT.index('mkdir -p "$BREEZER_STAGE"\n_root_dir=')
        end = SCRIPT.index('\nif [[ -f "$BREEZER_PREPARED" ]]; then\n  if [[ "$BREEZER_REFRESH_AI"')
        env = {key: value for key, value in os.environ.items() if not key.startswith('BREEZER_')}
        env.update(BREEZER_ROOT=str(ROOT), BREEZER_PYTHON=sys.executable, BREEZER_STAGE=str(stage),
                   BREEZER_BUILD_PROFILE='upstream')
        shell = 'set -euo pipefail\n' + SCRIPT[start:end] + '\necho "OUT=$_out_dir"\n'
        return subprocess.run(['bash', '-c', shell], cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)

    def test_changed_inputs_refuse_before_extracting_upstream_scripts(self):
        stage = self.root / 'stage'
        (stage / 'devutils').mkdir(parents=True)
        (stage / 'build/src/out/Default').mkdir(parents=True)
        (stage / 'build/.breezer-prepared').write_text('0' * 64 + '\n')
        sentinels = {stage / 'env.sh': 'old env', stage / 'devutils/shared.sh': 'old shared',
                     stage / 'build/src/out/Default/object.o': 'compiled'}
        for path, content in sentinels.items():
            path.write_text(content)
        result = self.run_preparation(stage)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('Build inputs changed', result.stderr)
        for path, content in sentinels.items():
            self.assertEqual(path.read_text(), content)
        self.assertFalse((stage / 'patches').exists())

    def test_unprepared_stage_receives_upstream_scripts_and_keeps_profile_output(self):
        stage = self.root / 'fresh stage'
        result = self.run_preparation(stage)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((stage / 'env.sh').read_bytes(),
                         subprocess.run(['git', 'show', 'HEAD:upstream/helium-macos/env.sh'], cwd=ROOT,
                                        check=True, capture_output=True).stdout)
        self.assertIn(f'OUT={stage}/build/src/out/', result.stdout)



class DirtyUpdateManifestTest(unittest.TestCase):
    def test_dmg_refuses_update_manifest_for_dirty_build(self):
        import package_breezer_dmg as dmg
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / 'Breezer.app'
            host = app / 'Contents/Frameworks/Breezer Framework.framework/Versions/1/Resources/breezer_ai/host'
            host.mkdir(parents=True)
            (host / 'build-identity.json').write_text(json.dumps({'commit': 'a' * 40, 'dirty': True}))
            with patch.object(dmg.platform, 'system', return_value='Darwin'), \
                 patch.object(dmg.Path, 'is_file', return_value=True), \
                 patch.object(dmg, 'resolve_paths', return_value=(app, root / 'Breezer.dmg', root / 'Breezer.dmg.sha256')):
                with self.assertRaisesRegex(ValueError, 'uncommitted changes'):
                    dmg.package(app, root / 'Breezer.dmg', verify_app=lambda _: None, update_manifest=root / 'breezer-update.json')
            self.assertFalse((root / 'breezer-update.json').exists())

if __name__ == '__main__':
    unittest.main()
