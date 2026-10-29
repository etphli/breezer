#!/usr/bin/env python3
"""Bundle Breezer's private AI host and checksum-pinned Node runtime."""

import argparse
import hashlib
import json
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
FEATURE = ROOT / "features/ai"
BUNDLE_ID = "io.github.etphli.breezer"


def verify_archive(archive, checksum):
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != checksum:
        raise ValueError(f"Node runtime checksum does not match its pin: {archive}")


def download_runtime(distribution, cache):
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / distribution["filename"]
    if archive.exists():
        verify_archive(archive, distribution["sha256"])
        return archive
    with tempfile.NamedTemporaryFile(dir=cache, prefix="node-", suffix=".part", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            with urllib.request.urlopen(distribution["url"], timeout=60) as response:
                shutil.copyfileobj(response, stream)
            stream.close()
            verify_archive(temporary, distribution["sha256"])
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    return archive


def unpack_runtime(archive, destination, distribution):
    verify_archive(archive, distribution["sha256"])
    prefix = distribution["filename"].removesuffix(".tar.gz")
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as source:
        for relative, output, limit in (("bin/node", "node", 200 * 1024 * 1024), ("LICENSE", "LICENSE", 2 * 1024 * 1024)):
            member = source.getmember(f"{prefix}/{relative}")
            if not member.isfile() or member.size > limit:
                raise ValueError(f"Invalid Node runtime archive member: {member.name}")
            with source.extractfile(member) as stream, (destination / output).open("wb") as target:
                shutil.copyfileobj(stream, target)
    (destination / "node").chmod(0o755)


def framework_resources(app):
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info.get("CFBundleIdentifier") != BUNDLE_ID or info.get("CFBundleExecutable") != "Breezer":
        raise ValueError("Package the source-built Breezer app with its own bundle identity.")
    versions = app / "Contents/Frameworks/Breezer Framework.framework/Versions"
    resources = {path.resolve() for path in versions.glob("*/Resources") if path.is_dir()}
    if len(resources) != 1:
        raise ValueError("Expected exactly one Breezer framework version in the app bundle.")
    result = resources.pop()
    if not result.is_relative_to(app.resolve()):
        raise ValueError("The Breezer framework resources must stay inside the app bundle.")
    return result


def package(app, architecture, cache):
    lock = json.loads((FEATURE / "runtime.lock.json").read_text())
    archive = download_runtime(lock["distributions"][architecture], cache)
    resources = framework_resources(app)
    with tempfile.TemporaryDirectory(prefix=".breezer-ai-", dir=resources) as temporary:
        staged = Path(temporary) / "breezer_ai"
        staged.mkdir()
        shutil.copytree(FEATURE / "host", staged / "host", ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
        shutil.copyfile(FEATURE / "integration/native-host-manifest.json", staged / "io.github.etphli.breezer.ai.json")
        (staged / "host/launch.sh").chmod(0o755)
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        (staged / "host/build-identity.json").write_text(json.dumps({"commit": commit}) + "\n")
        unpack_runtime(archive, staged / "runtime", lock["distributions"][architecture])
        runtime = staged / "runtime/node"
        if platform.system() == "Darwin" and architecture == {"arm64": "arm64", "x86_64": "x64"}.get(platform.machine()):
            version = subprocess.check_output([str(runtime), "--version"], text=True).strip()
            actual_architecture = subprocess.check_output([str(runtime), "-p", "process.arch"], text=True).strip()
            if version != f'v{lock["version"]}' or actual_architecture != architecture:
                raise ValueError("The bundled Node binary does not match its pinned version and architecture.")
        shutil.copyfile(FEATURE / "runtime.lock.json", staged / "runtime/lock.json")
        # This tool owns only this generated directory inside the build output.
        target = resources / "breezer_ai"
        if target.is_symlink():
            raise ValueError("The generated AI resources directory must not be a symlink.")
        if target.exists():
            shutil.rmtree(target)
        staged.replace(target)
    print(f"Bundled private AI host and Node {lock['version']} for {architecture}: {target}")
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--arch", choices=("arm64", "x64"), default={"arm64": "arm64", "x86_64": "x64"}.get(platform.machine()))
    parser.add_argument("--cache", type=Path, default=ROOT / "build/ai-runtime")
    args = parser.parse_args()
    if args.arch is None:
        parser.error("Specify the target app architecture with --arch.")
    package(args.app.resolve(), args.arch, args.cache.resolve())


if __name__ == "__main__":
    main()
