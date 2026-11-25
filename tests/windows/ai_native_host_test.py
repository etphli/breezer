"""Check the private host overlay and, when supplied, a Windows AI package."""

import json
import os
from pathlib import Path
from queue import Queue
import shutil
import struct
import subprocess
import sys
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'script'))
import apply_breezer_ai_windows_host as overlay


class NativeHostOverlayTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tree = Path(temporary.name)
        self.windows = self.tree / overlay.WINDOWS_LAUNCH
        self.common = self.tree / overlay.COMMON_LAUNCH
        self.windows.parent.mkdir(parents=True)
        self.windows.write_text(
            '#include "base/check.h"\n'
            '#include "base/numerics/safe_conversions.h"\n'
            '  std::wstring host_name_wide = base::UTF8ToWide(host_name);\n'
            '  found = GetManifestPath(HKEY_CURRENT_USER, host_name_wide, &path_str);\n',
            encoding='utf-8')
        self.common.write_text(
            '  std::string error_message;\n'
            '  base::FilePath manifest_path =\n'
            '      FindManifest(native_host_name, allow_user_level_hosts, error_message);\n'
            '  base::FilePath host_path = manifest->path();\n'
            '  if (!host_path.IsAbsolute()) {\n'
            '    return ExistingLaunchWithParentWindow();\n'
            '  }\n',
            encoding='utf-8')

    def test_origin_and_path_are_fixed_before_any_registry_or_shell_lookup(self):
        overlay.apply(self.tree)
        windows = self.windows.read_text(encoding='utf-8')
        private_lookup = windows.split(f'host_name == "{overlay.HOST}"', 1)[1].split(
            'std::wstring host_name_wide', 1)[0]
        self.assertIn('PathService::Get(base::DIR_MODULE', private_lookup)
        self.assertIn(f'host_dir.AppendASCII("{overlay.HOST}.json")', private_lookup)
        self.assertIn(f'host_dir.AppendASCII("{overlay.LAUNCHER}")', private_lookup)
        self.assertIn('FILE_ATTRIBUTE_REPARSE_POINT', private_lookup)
        self.assertTrue(private_lookup.strip().endswith('return base::FilePath();\n  }'))
        self.assertIn('GetManifestPath(HKEY_CURRENT_USER', windows)

        common = self.common.read_text(encoding='utf-8')
        self.assertLess(common.index(f'origin.spec() != "{overlay.ORIGIN}"'),
                        common.index('FindManifest('))
        self.assertIn('require_native_initiated_connections || !error_arg.empty()', common)
        private_launch = common.split('  if (breezer_ai) {', 1)[1].split('#endif', 1)[0]
        self.assertIn(f'host_path != base::FilePath(FILE_PATH_LITERAL("{overlay.LAUNCHER}"))',
                      private_launch)
        self.assertIn('manifest_path.DirName().Append(host_path)', private_launch)
        self.assertIn('LaunchNativeProcess(', private_launch)
        self.assertIn('/*native_hosts_executables_launch_directly=*/true', private_launch)
        self.assertEqual(private_launch.count('AppendArg('), 1)
        self.assertIn('AppendArg(origin.spec())', private_launch)
        self.assertIn('ExistingLaunchWithParentWindow()', common)

    def test_manifest_and_generated_launcher_identity_match_on_reapplication(self):
        overlay.apply(self.tree)
        generated = self.tree / overlay.COMPONENT
        files = [self.windows, self.common, *generated.iterdir()]
        before = [path.read_bytes() for path in files]
        overlay.apply(self.tree)
        self.assertEqual(before, [path.read_bytes() for path in files])

        manifest = json.loads(overlay.MANIFEST.read_text(encoding='utf-8'))
        self.assertEqual(manifest['allowed_origins'], [overlay.ORIGIN])
        self.assertEqual(manifest['name'], overlay.HOST)
        self.assertEqual(manifest['path'], overlay.LAUNCHER)
        identity = (generated / 'host_identity.h').read_text(encoding='utf-8')
        self.assertIn(f'L"{overlay.ORIGIN}"', identity)
        build = (generated / 'BUILD.gn').read_text(encoding='utf-8')
        self.assertIn('executable("breezer_ai_host")', build)
        self.assertIn('output_dir = "$root_out_dir/breezer_ai"', build)
        self.assertEqual((generated / 'host_launcher.cc').read_bytes(),
                         (overlay.FEATURE / 'host_launcher.cc').read_bytes())

    def test_overlay_rejects_manifest_overrides(self):
        original = json.loads(overlay.MANIFEST.read_text(encoding='utf-8'))
        overrides = [
            {'path': '../node.exe'},
            {'allowed_origins': [overlay.ORIGIN, 'chrome-extension://other/']},
            {'supports_native_initiated_connections': True},
        ]
        for change in overrides:
            with self.subTest(change=change):
                manifest = self.tree / 'manifest.json'
                manifest.write_text(json.dumps({**original, **change}), encoding='utf-8')
                with patch.object(overlay, 'MANIFEST', manifest):
                    with self.assertRaisesRegex(ValueError, 'integration identity'):
                        overlay.apply(self.tree)
        self.assertFalse((self.tree / overlay.COMPONENT).exists())


PACKAGE = os.environ.get('BREEZER_AI_WINDOWS_PACKAGE')


@unittest.skipUnless(sys.platform == 'win32' and PACKAGE,
                     'Set BREEZER_AI_WINDOWS_PACKAGE to a Windows breezer_ai directory')
class PackagedNativeHostTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='Breezer AI ')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.package = Path(PACKAGE).resolve(strict=True)
        self.launcher = self.package / overlay.LAUNCHER
        self.env = {
            **os.environ,
            'LOCALAPPDATA': str(self.directory / 'Local AppData'),
            'NODE_OPTIONS': '--breezer-test-rejected-by-node',
            'NODE_PATH': str(self.directory),
        }

    def invoke(self, *args, launcher=None, data=b''):
        return subprocess.run([str(launcher or self.launcher), *args],
                              input=data, capture_output=True, cwd=self.directory,
                              env=self.env, timeout=15)

    def test_rejects_other_origins_and_launch_flags(self):
        for args in ((), (overlay.ORIGIN.rstrip('/'),),
                     ('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',),
                     (overlay.ORIGIN, '--parent-window=123'), ('--discover',)):
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, b'')

    def test_pipes_round_trip_packaged_organato_message(self):
        payload = json.dumps({'type': 'organato-view', 'id': 'launcher-smoke'}).encode()
        launcher = self.open_launcher(self.launcher)
        launcher.stdin.write(struct.pack('<I', len(payload)) + payload)
        launcher.stdin.flush()

        def read_frame():
            (length,) = struct.unpack('<I', launcher.stdout.read(4))
            if not 0 < length <= 1024 * 1024:
                raise ValueError(f'Unexpected native message size {length}')
            return launcher.stdout.read(length)

        response = json.loads(self.read_output(read_frame))
        self.assertEqual(response['id'], 'launcher-smoke')
        self.assertEqual(response['type'], 'organato-result')
        self.assertTrue(response['ok'], response)
        self.assertFalse(response['value']['connected'])
        launcher.stdin.close()
        self.assertEqual(launcher.wait(timeout=10), 0)

    def test_missing_packaged_binary_cannot_fall_back_to_path(self):
        launcher = self.directory / overlay.LAUNCHER
        shutil.copyfile(self.launcher, launcher)
        (self.directory / 'runtime').mkdir()
        (self.directory / 'host').mkdir()
        (self.directory / 'host/main.mjs').write_text(
            'process.stdout.write("escaped bundled runtime");\n', encoding='utf-8')
        self.env['PATH'] = str(self.package / 'runtime')
        result = self.invoke(overlay.ORIGIN, launcher=launcher)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')

    def test_cancelling_launcher_terminates_node_and_its_child(self):
        launcher_path = self.directory / overlay.LAUNCHER
        shutil.copyfile(self.launcher, launcher_path)
        (self.directory / 'runtime').mkdir()
        shutil.copyfile(self.package / 'runtime/node.exe',
                        self.directory / 'runtime/node.exe')
        (self.directory / 'host').mkdir()
        (self.directory / 'host/main.mjs').write_text(
            'import { spawn } from "node:child_process";\n'
            'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],'
            ' { stdio: "ignore", windowsHide: true });\n'
            'child.on("spawn", () => console.log(JSON.stringify([process.pid, child.pid])));\n'
            'process.stdin.resume();\n'
            'process.stdin.on("end", () => child.kill());\n',
            encoding='utf-8')
        launcher = self.open_launcher(launcher_path)
        pids = json.loads(self.read_output(launcher.stdout.readline))
        self.assertEqual(len(pids), 2)
        self.verify_job_shutdown(launcher, pids)

    def open_launcher(self, path):
        launcher = subprocess.Popen([str(path), overlay.ORIGIN],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, cwd=self.directory, env=self.env)
        self.addCleanup(self.close_launcher, launcher)
        return launcher

    def close_launcher(self, launcher):
        self.stop(launcher)
        launcher.stdin.close()
        launcher.stdout.close()
        launcher.stderr.close()

    def stop(self, process):
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)

    def read_output(self, read):
        output = Queue()

        def receive():
            try:
                output.put(read())
            except Exception as error:
                output.put(error)

        Thread(target=receive, daemon=True).start()
        result = output.get(timeout=10)
        if isinstance(result, Exception):
            raise result
        self.assertTrue(result)
        return result

    def verify_job_shutdown(self, launcher, pids):
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handles = []
        try:
            for pid in pids:
                handle = kernel.OpenProcess(0x00100001, False, pid)  # SYNCHRONIZE | PROCESS_TERMINATE
                self.assertTrue(handle, ctypes.get_last_error())
                handles.append(handle)
            self.stop(launcher)
            for handle in handles:
                self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
        finally:
            for handle in reversed(handles):
                if kernel.WaitForSingleObject(handle, 0):
                    kernel.TerminateProcess(handle, 1)
                    kernel.WaitForSingleObject(handle, 5000)
                kernel.CloseHandle(handle)


if __name__ == '__main__':
    unittest.main()
