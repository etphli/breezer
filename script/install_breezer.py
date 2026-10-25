#!/usr/bin/env python3
"""Install a verified Breezer Apple Silicon artifact from an explicit GitHub run."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile


ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = "etphli/breezer"
WORKFLOW = ".github/workflows/build-breezer-macos.yml"
BUNDLE_ID = "io.github.etphli.breezer"
ARTIFACT = "Breezer-arm64"
ARCHIVE = ARTIFACT + ".zip"
MAX_BYTES = 30 * 1024 ** 3
MANIFEST = {
    "name": BUNDLE_ID + ".ai",
    "description": "Breezer local AI assistant",
    "path": "host/launch.sh",
    "type": "stdio",
    "allowed_origins": ["chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/"],
}


def command(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def github_json(endpoint):
    result = command(["gh", "api", "--hostname", "github.com", endpoint], capture_output=True, text=True)
    return json.loads(result.stdout)


def verify_run(run, run_id, commit):
    if (run.get("id") != run_id or run.get("repository", {}).get("full_name") != REPOSITORY
            or run.get("head_repository", {}).get("full_name") != REPOSITORY
            or run.get("path") != WORKFLOW or run.get("event") != "workflow_dispatch"
            or run.get("head_sha") != commit):
        raise ValueError("The run does not match the requested repository, workflow, and commit.")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ValueError("The requested native build has not completed successfully; nothing was installed.")


def select_artifact(pages, run_id, commit):
    artifacts = [artifact for page in pages for artifact in page["artifacts"] if artifact.get("name") == ARTIFACT]
    if len(artifacts) != 1:
        raise ValueError(f"Expected exactly one {ARTIFACT} artifact in the selected run.")
    artifact = artifacts[0]
    origin = artifact.get("workflow_run", {})
    if (artifact.get("expired") is not False or not isinstance(artifact.get("id"), int)
            or origin.get("id") != run_id or origin.get("head_sha") != commit):
        raise ValueError("The artifact is expired or does not belong to the requested run and commit.")
    return artifact


def download_artifact(run_id, commit, directory):
    run = github_json(f"repos/{REPOSITORY}/actions/runs/{run_id}")
    verify_run(run, run_id, commit)
    result = command([
        "gh", "api", "--hostname", "github.com", "--paginate", "--slurp",
        f"repos/{REPOSITORY}/actions/runs/{run_id}/artifacts?per_page=100",
    ], capture_output=True, text=True)
    artifact = select_artifact(json.loads(result.stdout), run_id, commit)
    outer = directory / "github-artifact.zip"
    with outer.open("wb") as stream:
        command(["gh", "api", "--hostname", "github.com",
                 f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip"], stdout=stream)
    archive = unpack_artifact(outer, directory)
    return archive, artifact


def unpack_artifact(outer, directory):
    with zipfile.ZipFile(outer) as source:
        members = source.infolist()
        if {member.filename for member in members} != {ARCHIVE, ARCHIVE + ".sha256"} or len(members) != 2:
            raise ValueError("The GitHub artifact must contain only the browser ZIP and its SHA-256 file.")
        for member in members:
            kind = stat.S_IFMT(member.external_attr >> 16)
            limit = 2048 if member.filename.endswith(".sha256") else MAX_BYTES
            if member.is_dir() or kind not in (0, stat.S_IFREG) or member.file_size > limit or member.flag_bits & 1:
                raise ValueError("Invalid or oversized GitHub artifact member.")
            with source.open(member) as stream, (directory / member.filename).open("wb") as output:
                shutil.copyfileobj(stream, output)
    archive = directory / ARCHIVE
    checksum = (directory / (ARCHIVE + ".sha256")).read_text(encoding="ascii")
    match = re.fullmatch(r"([a-fA-F0-9]{64})[ \t]+\*?(?:dist/)?Breezer-arm64\.zip\s*", checksum)
    if not match or sha256(archive) != match[1].lower():
        raise ValueError("The browser archive SHA-256 does not match its checksum file.")
    return archive


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def checked_member_name(name):
    if not name or "\\" in name or "\0" in name or name.startswith("/"):
        raise ValueError(f"Unsafe ZIP member: {name!r}")
    parts = name.rstrip("/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"Unsafe ZIP member: {name!r}")
    if parts[0] == "__MACOSX":
        if len(parts) > 1 and not (parts[1] == "Breezer.app" or parts[1] == "._Breezer.app"):
            raise ValueError("Unexpected AppleDouble metadata outside Breezer.app.")
    elif parts[0] != "Breezer.app":
        raise ValueError("The archive must contain Breezer.app, not a renamed browser.")
    return "/".join(parts)


def resolve_zip_path(name, links):
    pending = name.split("/")
    resolved = []
    follows = 0
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            if len(resolved) <= 1:
                raise ValueError("A ZIP symlink escapes Breezer.app.")
            resolved.pop()
            continue
        resolved.append(part)
        path = "/".join(resolved)
        if path in links:
            follows += 1
            if follows > 40:
                raise ValueError("A ZIP symlink is cyclic or too deeply nested.")
            target = links[path]
            if target.startswith("/") or "\\" in target or "\0" in target:
                raise ValueError("A ZIP symlink has an unsafe target.")
            resolved.pop()
            pending = target.split("/") + pending
    if not resolved or resolved[0] != "Breezer.app":
        raise ValueError("A ZIP symlink escapes Breezer.app.")


def inspect_archive(archive):
    with zipfile.ZipFile(archive) as source:
        members = source.infolist()
        if len(members) > 100000 or sum(member.file_size for member in members) > MAX_BYTES:
            raise ValueError("The browser archive exceeds the extraction limit.")
        names = set()
        links = {}
        for member in members:
            name = checked_member_name(member.filename)
            kind = stat.S_IFMT(member.external_attr >> 16)
            if name in names or kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK) or member.flag_bits & 1:
                raise ValueError("Duplicate, encrypted, or unsupported browser ZIP member.")
            names.add(name)
            if kind == stat.S_IFLNK:
                if not name.startswith("Breezer.app/") or member.file_size > 4096:
                    raise ValueError("Invalid browser ZIP symlink.")
                links[name] = source.read(member).decode("utf-8")
                if not links[name]:
                    raise ValueError("Empty browser ZIP symlink.")
        for name in names:
            if name.startswith("Breezer.app"):
                resolve_zip_path(name, links)
        if "Breezer.app/Contents/Info.plist" not in names:
            raise ValueError("The browser archive has no Breezer app Info.plist.")


def bundled_file(app, path, executable=False):
    target = app / path
    if not target.resolve().is_relative_to(app.resolve()) or not target.is_file():
        raise ValueError(f"Missing or escaped bundle file: {path}")
    if executable and not os.access(target, os.X_OK):
        raise ValueError(f"Bundle file is not executable: {path}")
    return target


def verify_arm64(path):
    with path.open("rb") as stream:
        header = stream.read(8)
    if len(header) != 8 or header[:4] != b"\xcf\xfa\xed\xfe" or struct.unpack("<I", header[4:])[0] != 0x0100000C:
        raise ValueError(f"Expected a native Apple Silicon Mach-O executable: {path}")


def verify_app(app):
    if app.is_symlink() or not app.is_dir():
        raise ValueError("Breezer.app must be a real application directory.")
    for directory, subdirectories, files in os.walk(app, followlinks=False):
        for name in subdirectories + files:
            path = Path(directory) / name
            if path.is_symlink() and not path.resolve().is_relative_to(app.resolve()):
                raise ValueError(f"An extracted symlink escapes the application: {path}")
    with bundled_file(app, "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if (info.get("CFBundleIdentifier") != BUNDLE_ID or info.get("CFBundleExecutable") != "Breezer"
            or info.get("CFBundleName") != "Breezer" or info.get("CFBundlePackageType") != "APPL"):
        raise ValueError("The app does not have Breezer's product identity.")
    verify_arm64(bundled_file(app, "Contents/MacOS/Breezer", executable=True))
    versions = app / "Contents/Frameworks/Breezer Framework.framework/Versions"
    resources = {path.resolve() for path in versions.glob("*/Resources") if path.is_dir()}
    if len(resources) != 1:
        raise ValueError("Expected exactly one bundled Breezer framework version.")
    resources = resources.pop()
    if not resources.is_relative_to(app.resolve()):
        raise ValueError("The framework resources escape Breezer.app.")
    relative = resources.relative_to(app.resolve())
    verify_arm64(bundled_file(app, relative.parent / "Breezer Framework", executable=True))
    ai = relative / "breezer_ai"
    for filename in ("main.mjs", "cli.mjs", "claude.mjs", "controller.mjs", "protocol.mjs", "codex.mjs"):
        bundled_file(app, ai / "host" / filename)
    bundled_file(app, ai / "host/launch.sh", executable=True)
    manifest = json.loads(bundled_file(app, ai / "io.github.etphli.breezer.ai.json").read_text())
    if manifest != MANIFEST:
        raise ValueError("The private AI native-host manifest does not match Breezer's extension.")
    lock = json.loads(bundled_file(app, ai / "runtime/lock.json").read_text())
    if lock != json.loads((ROOT / "features/ai/runtime.lock.json").read_text()):
        raise ValueError("The bundled Node runtime lock does not match this repository's checksum pin.")
    bundled_file(app, ai / "runtime/LICENSE")
    node = bundled_file(app, ai / "runtime/node", executable=True)
    verify_arm64(node)
    command(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", str(node)])
    command(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])


def running_pids(app):
    result = command(["/bin/ps", "-axo", "pid=,comm="], capture_output=True, text=True)
    executable = str(app / "Contents/MacOS/Breezer")
    return [int(parts[0]) for line in result.stdout.splitlines()
            if len(parts := line.strip().split(None, 1)) == 2 and parts[1] == executable]


@contextmanager
def install_lock(parent):
    descriptor = os.open(parent / ".Breezer-install.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Another Breezer installation is already running.") from error
        yield


def install_app(staged, destination, receipt, receipt_directory, verify=verify_app):
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        raise ValueError("The installation destination is not a real app directory.")
    if running_pids(destination):
        raise ValueError("Quit the installed Breezer before replacing it.")
    backup = None
    installed = False
    try:
        if destination.exists():
            backups = destination.parent / ".Breezer-backups"
            if backups.is_symlink():
                raise ValueError("The backup directory must not be a symlink.")
            backups.mkdir(exist_ok=True)
            backup = backups / f"Breezer-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:8]}.app"
            destination.rename(backup)
        staged.rename(destination)
        installed = True
        verify(destination)
        receipt = dict(receipt, destination=str(destination), backup=str(backup) if backup else None,
                       installed_at=datetime.now(timezone.utc).isoformat())
        receipt_directory.mkdir(parents=True, exist_ok=True)
        receipt_path = receipt_directory / f"{receipt['run_id']}-{uuid.uuid4().hex}.json"
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=".receipt-", dir=receipt_directory, delete=False) as stream:
            temporary_receipt = Path(stream.name)
            try:
                json.dump(receipt, stream, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
                temporary_receipt.replace(receipt_path)
            finally:
                temporary_receipt.unlink(missing_ok=True)
    except BaseException:
        if installed:
            destination.rename(staged)
        if backup is not None:
            backup.rename(destination)
        raise
    return backup, receipt_path


def launch_app(destination):
    try:
        command(["/usr/bin/open", str(destination)])
    except subprocess.CalledProcessError as error:
        raise ValueError("Breezer was installed, but macOS did not open it. Review macOS's launch prompt.") from error
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        pids = running_pids(destination)
        if pids:
            time.sleep(1)
            if running_pids(destination):
                return pids
        time.sleep(0.25)
    raise ValueError("Breezer was installed, but its running process could not be verified. Review macOS's launch prompt.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", type=int, required=True, help="Successful GitHub Actions build run ID")
    parser.add_argument("--commit", required=True, help="Exact 40-character commit SHA compiled by that run")
    parser.add_argument("--destination", type=Path, default=Path.home() / "Applications/Breezer.app")
    parser.add_argument("--no-launch", action="store_true", help="Install without opening Breezer")
    args = parser.parse_args()
    if args.run_id <= 0 or not re.fullmatch(r"[a-fA-F0-9]{40}", args.commit):
        parser.error("Use a positive run ID and a complete 40-character commit SHA.")
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("This installer requires an Apple Silicon Mac.")
    if not shutil.which("gh"):
        parser.error("Install GitHub CLI and sign in with gh auth login first.")
    destination = args.destination.expanduser().absolute()
    if destination.name != "Breezer.app":
        parser.error("The destination must be named Breezer.app.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination = destination.parent.resolve() / destination.name
    commit = args.commit.lower()
    with install_lock(destination.parent), tempfile.TemporaryDirectory(prefix=".breezer-install-", dir=destination.parent) as temporary:
        work = Path(temporary)
        archive, artifact = download_artifact(args.run_id, commit, work)
        inspect_archive(archive)
        extracted = work / "extracted"
        extracted.mkdir()
        command(["/usr/bin/ditto", "-x", "-k", str(archive), str(extracted)])
        staged = extracted / "Breezer.app"
        verify_app(staged)
        receipt = {"repository": REPOSITORY, "workflow": WORKFLOW, "run_id": args.run_id,
                   "commit": commit, "artifact_id": artifact["id"], "artifact_name": ARTIFACT,
                   "archive_sha256": sha256(archive),
                   "run_url": f"https://github.com/{REPOSITORY}/actions/runs/{args.run_id}"}
        receipt_directory = Path.home() / "Library/Application Support/io.github.etphli.breezer-installer/receipts"
        backup, receipt_path = install_app(staged, destination, receipt, receipt_directory)
        print(f"Installed verified Breezer: {destination}")
        if backup:
            print(f"Previous app retained: {backup}")
        print(f"Installation receipt: {receipt_path}")
        if not args.no_launch:
            print(f"Breezer process verified: {', '.join(map(str, launch_app(destination)))}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile, KeyError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) and error.stderr else str(error)
        print(f"Breezer installer: {detail}", file=sys.stderr)
        sys.exit(1)
