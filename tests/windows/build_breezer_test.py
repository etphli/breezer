import hashlib
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "script/windows/build_breezer.py"
sys.path.insert(0, str(SCRIPT.parent))
import build_breezer
import apply_breezer_windows


def executable(path, machine=0x8664):
    data = bytearray(128)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 64)
    struct.pack_into("<4sH", data, 64, b"PE\0\0", machine)
    path.write_bytes(data)


class WindowsPackageTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.stage = Path(temporary.name)
        self.output = self.stage / "src/out/Default"
        self.output.mkdir(parents=True)
        self.artifacts = self.stage / "artifacts"

        lock = build_breezer.load_lock()
        build_breezer.write_marker(self.output / build_breezer.BUILD_MARKER,
                                   build_breezer.prepared_inputs(lock))
        self.portable = ("chrome.exe", "chrome.dll", "chrome_elf.dll", "chrome_100_percent.pak", "chrome_200_percent.pak",
                         "icudtl.dat", "resources.pak", "locales/en-US.pak", "v8_context_snapshot.bin")
        (self.output / "locales").mkdir()
        for name in (*self.portable, "mini_installer.exe", "setup.exe", "chrome.pdb"):
            executable(self.output / name)
        config = self.stage / "src/chrome/tools/build/win/FILES.cfg"
        config.parent.mkdir(parents=True)
        files = [dict(filename=name, buildtype=["official"]) for name in (*self.portable,
                 "mini_installer.exe", "setup.exe", "chrome.pdb", "*.exe")]
        config.write_text(f"FILES = {files!r}", encoding="utf-8")

    def package(self):
        return subprocess.run([sys.executable, SCRIPT, "package", "--build-dir", self.stage],
                              capture_output=True, encoding="utf-8")

    def test_native_installer_zip_and_checksum_contents(self):
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        installer = self.artifacts / build_breezer.INSTALLER
        portable = self.artifacts / build_breezer.PORTABLE
        self.assertEqual(installer.read_bytes(), (self.output / "mini_installer.exe").read_bytes())
        with ZipFile(portable) as archive:
            self.assertEqual(set(archive.namelist()), {f"{portable.stem}/{name}" for name in self.portable})
            for name in self.portable:
                self.assertEqual(archive.read(f"{portable.stem}/{name}"), (self.output / name).read_bytes())
        for artifact in (installer, portable):
            checksum = artifact.with_name(artifact.name + ".sha256").read_text(encoding="ascii")
            expected = hashlib.sha256(artifact.read_bytes()).hexdigest()
            self.assertEqual(checksum, f"{expected}  {artifact.name}\n")
        self.assertNotEqual(self.package().returncode, 0)

    def test_wrong_cpu_installer_is_rejected(self):
        executable(self.output / "mini_installer.exe", machine=0x014C)
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Expected an x64 Windows executable", result.stderr)
        self.assertFalse(self.artifacts.exists())

    def test_missing_portable_resource_leaves_no_artifacts(self):
        for path in ("resources.pak", "locales/en-US.pak", "chrome_200_percent.pak"):
            with self.subTest(path=path):
                (self.output / path).unlink()
                result = self.package()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"{Path(build_breezer.PORTABLE).stem}/{path}", result.stderr)
                self.assertFalse(self.artifacts.exists())
                executable(self.output / path)

    def test_generated_locale_outside_manifest_remains_available(self):
        locale = "locales/af.pak"
        executable(self.output / locale)
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        portable = self.artifacts / build_breezer.PORTABLE
        with ZipFile(portable) as archive:
            self.assertIn(f"{portable.stem}/{locale}", archive.namelist())

    def test_unfinished_build_cannot_package_previous_outputs(self):
        (self.output / build_breezer.BUILD_MARKER).unlink()
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing or mismatched build inputs", result.stderr)
        self.assertFalse(self.artifacts.exists())


class WindowsOverlayTest(unittest.TestCase):
    def test_branding_preserves_lf_anchors_for_later_overlays(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "delegate.cc"
            source.write_bytes(b'#include "contents_web_view.h"\r\nconst auto scheme = helium;\r\n')
            replace = apply_breezer_windows.branding.replace_file
            replace(source, {"= helium;": "= breezer;"})
            expected = b'#include "contents_web_view.h"\nconst auto scheme = breezer;\n'
            self.assertEqual(source.read_bytes(), expected)
            replace(source, {"= helium;": "= breezer;"})
            self.assertEqual(source.read_bytes(), expected)

    def test_import_patch_with_windows_line_endings_applies_and_reapplies(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            overlay = repo / "features/passwords/native-ui/windows-import.patch"
            overlay.parent.mkdir(parents=True)
            overlay.write_bytes(b"--- a/input.txt\r\n+++ b/input.txt\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n")
            source = repo / "src"
            source.mkdir()
            target = source / "input.txt"
            target.write_bytes(b"old\n")
            with patch.object(apply_breezer_windows, "ROOT", repo):
                apply_breezer_windows.apply_import_patch(source)
                self.assertEqual(target.read_bytes(), b"new\n")
                apply_breezer_windows.apply_import_patch(source)
                self.assertEqual(target.read_bytes(), b"new\n")


if __name__ == "__main__":
    unittest.main()
