#!/usr/bin/env python3
"""Unit checks for installer refusal and rollback, using synthetic filesystem fixtures.

These checks do not launch a browser or validate a real macOS signature.
"""

import hashlib
import json
from pathlib import Path
import plistlib
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import install_breezer as installer


COMMIT = "a" * 40


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def run_metadata(self):
        return {"id": 123, "repository": {"full_name": installer.REPOSITORY},
                "head_repository": {"full_name": installer.REPOSITORY}, "path": installer.WORKFLOW,
                "event": "workflow_dispatch", "head_sha": COMMIT, "status": "completed", "conclusion": "success"}

    def test_requires_successful_exact_build(self):
        installer.verify_run(self.run_metadata(), 123, COMMIT)
        for key, value in (("id", 124), ("repository", {"full_name": "elsewhere/browser"}),
                           ("head_repository", {"full_name": "elsewhere/browser"}),
                           ("path", ".github/workflows/other.yml"), ("head_sha", "b" * 40),
                           ("event", "pull_request"), ("status", "in_progress"), ("conclusion", "failure")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                installer.verify_run(dict(self.run_metadata(), **{key: value}), 123, COMMIT)

    def artifact(self):
        return {"id": 456, "name": installer.ARTIFACT, "expired": False,
                "workflow_run": {"id": 123, "head_sha": COMMIT}}

    def test_requires_one_unexpired_artifact_for_commit(self):
        artifact = self.artifact()
        self.assertEqual(installer.select_artifact([{"artifacts": [artifact]}], 123, COMMIT), artifact)
        for artifacts in ([], [artifact, artifact], [dict(artifact, expired=True)],
                          [dict(artifact, workflow_run={"id": 124, "head_sha": COMMIT})],
                          [dict(artifact, workflow_run={"id": 123, "head_sha": "b" * 40})]):
            with self.subTest(artifacts=artifacts), self.assertRaises(ValueError):
                installer.select_artifact([{"artifacts": artifacts}], 123, COMMIT)

    def outer_archive(self, checksum=None, extra=False):
        payload = b"browser archive fixture"
        outer = self.root / "outer.zip"
        checksum = checksum or hashlib.sha256(payload).hexdigest()
        with zipfile.ZipFile(outer, "w") as archive:
            archive.writestr(installer.ARCHIVE, payload)
            archive.writestr(installer.ARCHIVE + ".sha256", f"{checksum}  dist/{installer.ARCHIVE}\n")
            if extra:
                archive.writestr("../escape", b"unsafe")
        return outer

    def test_verifies_workflow_checksum_format(self):
        archive = installer.unpack_artifact(self.outer_archive(), self.root)
        self.assertEqual(archive.read_bytes(), b"browser archive fixture")

    def test_rejects_tampered_browser_archive(self):
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            installer.unpack_artifact(self.outer_archive("0" * 64), self.root)

    def test_outer_archive_cannot_extract_additional_paths(self):
        with self.assertRaises(ValueError):
            installer.unpack_artifact(self.outer_archive(extra=True), self.root)
        self.assertFalse((self.root.parent / "escape").exists())

    def browser_archive(self, extra=(), links=()):
        output = self.root / "browser.zip"
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("Breezer.app/Contents/Info.plist", b"plist fixture")
            for name in extra:
                archive.writestr(name, b"fixture")
            for name, target in links:
                member = zipfile.ZipInfo(name)
                member.create_system = 3
                member.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(member, target)
        return output

    def test_accepts_internal_framework_symlinks(self):
        installer.inspect_archive(self.browser_archive(links=[
            ("Breezer.app/Contents/Frameworks/F.framework/Versions/Current", "156"),
            ("Breezer.app/Contents/Frameworks/F.framework/Resources", "Versions/Current/Resources"),
        ]))

    def test_rejects_traversal_absolute_and_foreign_app_paths(self):
        for name in ("../escape", "/tmp/escape", "Breezer.app/../escape", "Helium.app/Contents/Info.plist",
                     "Breezer.app/Contents\\escape", "__MACOSX/Other.app/._file"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                installer.inspect_archive(self.browser_archive(extra=[name]))

    def test_rejects_symlink_escape_cycle_and_nested_escape(self):
        for links in ([('Breezer.app/Contents/escape', '/tmp/outside')],
                      [('Breezer.app/Contents/escape', '../../../outside')],
                      [('Breezer.app/Contents/a', 'b'), ('Breezer.app/Contents/b', 'a')],
                      [('Breezer.app/Contents/a', '..'), ('Breezer.app/Contents/b', 'a/../../outside')]):
            with self.subTest(links=links), self.assertRaises(ValueError):
                installer.inspect_archive(self.browser_archive(links=links))

    def make_app(self):
        app = Path(tempfile.mkdtemp(dir=self.root)) / "Breezer.app"
        contents = app / "Contents"
        contents.mkdir(parents=True)
        with (contents / "Info.plist").open("wb") as stream:
            plistlib.dump({"CFBundleIdentifier": installer.BUNDLE_ID, "CFBundleExecutable": "Breezer",
                           "CFBundleName": "Breezer", "CFBundlePackageType": "APPL"}, stream)
        resources = contents / "Frameworks/Breezer Framework.framework/Versions/156/Resources"
        ai = resources / "breezer_ai"
        for filename in ("main.mjs", "cli.mjs", "claude.mjs", "controller.mjs", "protocol.mjs", "codex.mjs", "launch.sh"):
            path = ai / "host" / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic host fixture")
            path.chmod(0o755)
        runtime = ai / "runtime"
        runtime.mkdir()
        (runtime / "LICENSE").write_text("synthetic licence fixture")
        (runtime / "lock.json").write_text((installer.ROOT / "features/ai/runtime.lock.json").read_text())
        (ai / "io.github.etphli.breezer.ai.json").write_text(json.dumps(installer.MANIFEST))
        for path in (contents / "MacOS/Breezer", resources.parent / "Breezer Framework", runtime / "node"):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01synthetic Mach-O header fixture")
            path.chmod(0o755)
        return app, ai

    def test_structural_check_requests_strict_node_and_deep_app_signatures(self):
        app, ai = self.make_app()
        with patch.object(installer, "command") as command:
            installer.verify_app(app)
        self.assertEqual(command.call_args_list[0].args[0], ["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", str(ai / "runtime/node")])
        self.assertEqual(command.call_args_list[1].args[0], ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])

    def test_rejects_wrong_identity_missing_host_and_manifest(self):
        for failure in ("identity", "host", "manifest", "runtime", "signature"):
            with self.subTest(failure=failure):
                app, ai = self.make_app()
                if failure == "identity":
                    with (app / "Contents/Info.plist").open("wb") as stream:
                        plistlib.dump({"CFBundleIdentifier": "net.imput.helium"}, stream)
                elif failure == "host":
                    (ai / "host/main.mjs").unlink()
                elif failure == "manifest":
                    manifest = dict(installer.MANIFEST, allowed_origins=["*"])
                    (ai / "io.github.etphli.breezer.ai.json").write_text(json.dumps(manifest))
                elif failure == "runtime":
                    (ai / "runtime/node").write_bytes(b"#!/bin/sh\n")
                with patch.object(installer, "command", side_effect=subprocess.CalledProcessError(1, "codesign")):
                    with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                        installer.verify_app(app)

    def staged_app(self):
        staged = self.root / "staged/Breezer.app"
        staged.mkdir(parents=True)
        (staged / "version").write_text("new")
        destination = self.root / "Applications/Breezer.app"
        destination.mkdir(parents=True)
        (destination / "version").write_text("old")
        return staged, destination

    def test_replacement_retains_previous_app_and_external_receipt(self):
        staged, destination = self.staged_app()
        with patch.object(installer, "running_pids", return_value=[]):
            backup, receipt = installer.install_app(staged, destination, {"run_id": 123}, self.root / "receipts", verify=lambda app: None)
        self.assertEqual((backup / "version").read_text(), "old")
        self.assertEqual((destination / "version").read_text(), "new")
        self.assertFalse(receipt.is_relative_to(destination))
        self.assertEqual(json.loads(receipt.read_text())["backup"], str(backup))

    def test_validation_or_receipt_failure_restores_previous_app(self):
        staged, destination = self.staged_app()
        for failure in ("validation", "receipt"):
            with self.subTest(failure=failure):
                receipts = self.root / "receipts"
                if failure == "receipt":
                    receipts.write_text("cannot be a directory")
                def verify(app):
                    if failure == "validation":
                        raise ValueError("signature rejected")
                with patch.object(installer, "running_pids", return_value=[]), self.assertRaises((ValueError, OSError)):
                    installer.install_app(staged, destination, {"run_id": 123}, receipts, verify=verify)
                self.assertEqual((destination / "version").read_text(), "old")
                self.assertEqual((staged / "version").read_text(), "new")

    def test_refuses_replacement_of_running_or_symlinked_app(self):
        staged, destination = self.staged_app()
        with patch.object(installer, "running_pids", return_value=[42]), self.assertRaisesRegex(ValueError, "Quit"):
            installer.install_app(staged, destination, {}, self.root / "receipts")
        link = self.root / "linked.app"
        link.symlink_to(destination, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "real app directory"):
            installer.install_app(staged, link, {}, self.root / "receipts")
        self.assertEqual((destination / "version").read_text(), "old")

    def test_serializes_installers(self):
        with installer.install_lock(self.root):
            with self.assertRaisesRegex(ValueError, "already running"):
                with installer.install_lock(self.root):
                    self.fail("A second installer acquired the same lock")


if __name__ == "__main__":
    unittest.main(verbosity=2)
