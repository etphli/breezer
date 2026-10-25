#!/usr/bin/env python3
"""Check the AI runtime packaging boundary without requiring Xcode or a download."""

import hashlib
import io
from pathlib import Path
import plistlib
import tarfile
import tempfile
import unittest

from package_breezer_ai import framework_resources, unpack_runtime


class RuntimePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / "node-fixture.tar.gz"

    def write_archive(self, symlink=False):
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in (("bin/node", b"runtime fixture"), ("LICENSE", b"runtime licence"), ("../../escape", b"must stay in archive")):
                member = tarfile.TarInfo(f"node-fixture/{name}")
                if symlink and name == "bin/node":
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/usr/bin/something"
                    archive.addfile(member)
                else:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
        return {"filename": self.archive.name, "sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest()}

    def test_extracts_only_pinned_binary_and_licence(self):
        pin = self.write_archive()
        target = self.root / "runtime"
        unpack_runtime(self.archive, target, pin)
        self.assertEqual({path.name for path in target.iterdir()}, {"node", "LICENSE"})
        self.assertEqual((target / "node").read_bytes(), b"runtime fixture")
        self.assertTrue((target / "node").stat().st_mode & 0o111)
        self.assertFalse((self.root / "escape").exists())

    def test_rejects_tampered_archive_before_extracting(self):
        pin = self.write_archive()
        self.archive.write_bytes(self.archive.read_bytes() + b"tampered")
        target = self.root / "runtime"
        with self.assertRaisesRegex(ValueError, "checksum"):
            unpack_runtime(self.archive, target, pin)
        self.assertFalse(target.exists())

    def test_rejects_symlink_in_place_of_runtime(self):
        pin = self.write_archive(symlink=True)
        with self.assertRaisesRegex(ValueError, "archive member"):
            unpack_runtime(self.archive, self.root / "runtime", pin)

    def make_app(self):
        app = self.root / "Breezer.app"
        contents = app / "Contents"
        contents.mkdir(parents=True)
        with (contents / "Info.plist").open("wb") as stream:
            plistlib.dump({"CFBundleIdentifier": "io.github.etphli.breezer", "CFBundleExecutable": "Breezer"}, stream)
        versions = contents / "Frameworks/Breezer Framework.framework/Versions"
        resources = versions / "156/Resources"
        resources.mkdir(parents=True)
        (versions / "Current").symlink_to("156", target_is_directory=True)
        return app, resources

    def test_current_version_symlink_is_one_bundled_framework(self):
        app, resources = self.make_app()
        self.assertEqual(framework_resources(app), resources.resolve())

    def test_framework_cannot_point_outside_the_app(self):
        app, resources = self.make_app()
        resources.rmdir()
        outside = self.root / "outside"
        outside.mkdir()
        resources.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "inside the app"):
            framework_resources(app)


if __name__ == "__main__":
    unittest.main(verbosity=2)
