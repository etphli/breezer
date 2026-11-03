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
from breezer_release import release_version


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


def verify_memory_host(app, packet):
    manifest = json.loads((packet / 'host-update.json').read_text())
    if manifest.get('resource') != 'breezer_ai/host/protocol.mjs':
        raise ValueError('Unexpected host resource in memory packet')
    resources = manifest.get('hostResources')
    names = {path.name for path in (FEATURE / 'host').glob('*.mjs')}
    if not isinstance(resources, dict) or set(resources) != names or resources.get('protocol.mjs') != manifest['after']:
        raise ValueError('Unexpected native host resource set in memory packet')
    host = framework_resources(app) / 'breezer_ai/host'
    checked = {}
    for name in sorted(names):
        if hashlib.sha256((packet / ('host-' + name)).read_bytes()).hexdigest() != resources[name]:
            raise ValueError('Host memory packet checksum mismatch: ' + name)
        installed = host / name
        if installed.is_symlink() or not installed.resolve().is_relative_to(app.resolve()):
            raise ValueError('Native host resource must remain inside the app')
        if hashlib.sha256(installed.read_bytes()).hexdigest() != resources[name]:
            raise ValueError('Packaged native host does not match the tested memory change: ' + name)
        checked[name] = {'resource': str(installed), 'sha256': resources[name]}
    return {'resources': checked}


def package(app, architecture, cache, memory_packet=None):
    version = release_version(ROOT)
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
            runtime_version = subprocess.check_output([str(runtime), "--version"], text=True).strip()
            actual_architecture = subprocess.check_output([str(runtime), "-p", "process.arch"], text=True).strip()
            if runtime_version != f'v{lock["version"]}' or actual_architecture != architecture:
                raise ValueError("The bundled Node binary does not match its pinned version and architecture.")
        shutil.copyfile(FEATURE / "runtime.lock.json", staged / "runtime/lock.json")
        # This tool owns only this generated directory inside the build output.
        target = resources / "breezer_ai"
        if target.is_symlink():
            raise ValueError("The generated AI resources directory must not be a symlink.")
        if target.exists():
            shutil.rmtree(target)
        staged.replace(target)
    if memory_packet is not None:
        verify_memory_host(app, memory_packet)
    stamp_bundle_version(app, version)
    print(f"Bundled Breezer {version}, private AI host and Node {lock['version']} for {architecture}: {target}")
    return target


def stamp_bundle_version(app, version):
    path = app / 'Contents/Info.plist'
    if path.is_symlink():
        raise ValueError('The app Info.plist must not be a symlink.')
    raw = path.read_bytes()
    info = plistlib.loads(raw)
    if info.get('CFBundleIdentifier') != BUNDLE_ID:
        raise ValueError('Only the Breezer app receives its release version.')
    info['CFBundleShortVersionString'] = version
    info['CFBundleVersion'] = version
    fmt = plistlib.FMT_BINARY if raw.startswith(b'bplist') else plistlib.FMT_XML
    path.write_bytes(plistlib.dumps(info, fmt=fmt))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--arch", choices=("arm64", "x64"), default={"arm64": "arm64", "x86_64": "x64"}.get(platform.machine()))
    parser.add_argument("--cache", type=Path, default=ROOT / "build/ai-runtime")
    parser.add_argument("--memory-packet", type=Path, help="Require the tested native host receipt after packaging")
    args = parser.parse_args()
    if args.arch is None:
        parser.error("Specify the target app architecture with --arch.")
    package(args.app.resolve(), args.arch, args.cache.resolve(), args.memory_packet.resolve() if args.memory_packet else None)


if __name__ == "__main__":
    main()
