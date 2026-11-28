#!/usr/bin/env python3
"""Prepare, compile, and package a native Windows x64 Breezer build."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from zipfile import ZipFile

import stage_breezer_ai

ROOT = Path(__file__).resolve().parents[2]
PATCH_EXCLUSIONS = {"windows-disable-encryption.patch", "windows-disable-download-warning-prompt.patch"}
SOURCE_MARKER = ".breezer-windows-source.json"
BUILD_MARKER = ".breezer-windows-built.json"
INSTALLER = "Breezer-Windows-x64-Setup.exe"
PORTABLE = "Breezer-Windows-x64.zip"
PORTABLE_EXCLUSIONS = set(map(Path, (
    "mini_installer.exe", "mini_installer_exe_version.rc", "setup.exe", "helium.packed.7z",
)))
# Overlays that insert source text. Re-applying a changed one over its earlier
# result can insert a second copy, so a prepared tree accepts only the inputs it
# was first built with.
OVERLAY_SCRIPTS = (
    "script/apply_breezer_omnibox.py", "script/apply_breezer_workspace.py", "script/apply_breezer_ai_ui.py",
    "features/passwords/native-ui/apply.py", "script/apply_breezer_sync.py",
)
OVERLAY_FILES = (
    "script/apply_breezer_ai.py", "script/apply_breezer_ai_windows_host.py", "script/apply_breezer_branding.py",
    "script/windows/apply_breezer_windows.py", "script/windows/stage_breezer_ai.py",
    "features/passwords/native-ui/windows-import.patch",
)
OVERLAY_DIRECTORIES = ("features/ai/integration", "features/ai/windows")


def run(*command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def git(directory, *arguments):
    return run("git", "-C", directory, *arguments, capture_output=True,
               encoding="utf-8").stdout.strip()


def write_marker(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_marker(path, expected, optional=()):
    data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
    if not isinstance(data, dict) or {key: value for key, value in data.items() if key not in optional} != expected:
        raise ValueError(f"Missing or mismatched build inputs at {path}.")
    return data


def overlay_fingerprints():
    result = {name: run(sys.executable, ROOT / name, "--fingerprint", capture_output=True,
                        encoding="utf-8").stdout.strip() for name in OVERLAY_SCRIPTS}
    files = [ROOT / name for name in OVERLAY_FILES]
    files.extend(path for directory in OVERLAY_DIRECTORIES for path in (ROOT / directory).rglob("*") if path.is_file())
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(path.relative_to(ROOT).as_posix().encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    result["windows_overlay_files"] = digest.hexdigest()
    return result


def breezer_inputs():
    return {"breezer_commit": git(ROOT, "rev-parse", "HEAD"), "breezer_overlays": overlay_fingerprints()}


def record_overlays(marker, expected, breezer):
    """Refuse to re-apply changed overlays to a tree that already holds older ones."""
    data = read_marker(marker, expected, optional=tuple(breezer))
    previous = data.get("breezer_overlays")
    if previous is not None and previous != breezer["breezer_overlays"]:
        changed = ", ".join(sorted(name for name in {*previous, *breezer["breezer_overlays"]}
                                   if previous.get(name) != breezer["breezer_overlays"].get(name)))
        raise ValueError(
            f"Breezer overlay inputs changed ({changed}) since {marker.parent} was built from commit "
            f"{data.get('breezer_commit', 'unknown')}. Re-applying them would duplicate inserted source. "
            f"Remove {marker.parent} and run prepare again, or use a separate --build-dir.")
    # Record before applying, so an interrupted apply is retried only with the same inputs.
    write_marker(marker, {**expected, **breezer})


@contextmanager
def build_lock(build_dir):
    build_dir.mkdir(parents=True, exist_ok=True)
    with (build_dir / ".breezer-windows.lock").open("a+b") as stream:
        if os.name == "nt":
            from msvcrt import LK_NBLCK, locking

            stream.seek(0)
            locking(stream.fileno(), LK_NBLCK, 1)
        else:
            from fcntl import LOCK_EX, LOCK_NB, flock

            flock(stream.fileno(), LOCK_EX | LOCK_NB)
        yield


def platform_checkout(build_dir, lock):
    pins = lock["helium_windows"]
    platform = build_dir / "helium-windows"
    if not platform.exists():
        with tempfile.TemporaryDirectory(prefix="helium-windows-", dir=build_dir) as temporary:
            clone = Path(temporary) / "checkout"
            run("git", "clone", "--depth=1", "--branch", lock["release"],
                "-c", "core.autocrlf=false", pins["repository"], clone)
            if git(clone, "rev-parse", "HEAD") != pins["commit"]:
                raise ValueError("The Helium Windows release tag does not match upstream.windows.lock.json.")
            clone.rename(platform)
    if git(platform, "rev-parse", "HEAD") != pins["commit"]:
        raise ValueError(f"Unexpected Helium Windows Git revision at {platform}.")
    git(platform, "diff", "--quiet", "HEAD", "--")
    upstream_core = git(platform, "ls-tree", "HEAD", "helium-chromium")
    if upstream_core != f'160000 commit {lock["helium"]["commit"]}\thelium-chromium':
        raise ValueError("The Helium Windows patch set requires a different shared Helium core.")
    return platform


def prepared_inputs(lock):
    return {
        "helium_windows": lock["helium_windows"]["commit"],
        "helium": lock["helium"]["commit"],
        "source_sha256": lock["helium_windows"]["source_sha256"],
        "skipped_patches": sorted(PATCH_EXCLUSIONS),
    }


def load_lock():
    lock = json.loads((ROOT / "upstream.lock.json").read_text(encoding="utf-8"))
    lock["helium_windows"] = json.loads((ROOT / "upstream.windows.lock.json").read_text(encoding="utf-8"))
    return lock


def fetch_sources(build_dir, core, platform, expected):
    import downloads

    cache = build_dir / "download_cache"
    cache.mkdir(exist_ok=True)
    info = downloads.DownloadInfo((core / "downloads.ini", platform / "downloads.x64.ini",
                                   platform / "downloads.ini", core / "deps.ini"))
    components = tuple(name for name in info if name != "nsis")
    downloads.retrieve_downloads(info, cache, components, show_progress=False)
    for archive, checksum in expected["source_sha256"].items():
        sidecar = cache / f"{archive}.hashes"
        if sidecar.read_text(encoding="utf-8").split() != ["sha256", checksum, archive]:
            raise ValueError(f"Archive checksum metadata differs from upstream.windows.lock.json at {sidecar}.")
    try:
        downloads.check_downloads(info, cache, components)
    except downloads.HashMismatchError as error:
        raise ValueError(f"Download checksum failed for {error}") from error
    return info, cache, components


def apply_helium_patches(source, core, platform, patch_tool):
    import patches

    shared_series = patches.generate_patches_from_series(core / "patches", resolve=True)
    windows_series = list(patches.generate_patches_from_series(platform / "patches", resolve=True))
    if not PATCH_EXCLUSIONS <= {path.name for path in windows_series}:
        raise ValueError("Recheck Windows security patches for this Helium version.")
    windows_series = [path for path in windows_series if path.name not in PATCH_EXCLUSIONS]
    patches.apply_patches(shared_series, source, patch_bin_path=patch_tool)
    patches.apply_patches(windows_series, source, patch_bin_path=patch_tool)


def copy_helium_resources(source, core, platform, build_dir):
    import generate_resources
    import replace_resources

    with tempfile.TemporaryDirectory(prefix="resources-", dir=build_dir) as temporary:
        temporary = Path(temporary)
        shutil.copytree(core / "resources", temporary / "helium-chromium/resources")
        shared_resources = temporary / "helium-chromium/resources"
        windows_resources = temporary / "resources"
        shutil.copytree(platform / "resources", windows_resources)
        for resources, manifest in ((windows_resources, "platform_resources.txt"),
                                    (shared_resources, "helium_resources.txt")):
            generate_resources.generate_resources(resources / "generate_resources.txt", resources)
            replace_resources.copy_resources(resources / manifest, resources, source)


def prepare_sources(build_dir, core, platform, expected):
    from _common import ExtractorEnum, USE_REGISTRY
    import domain_substitution
    import downloads
    import helium_version
    import i18n_apply
    import name_substitution
    import prune_binaries

    source = build_dir / "src"
    if source.exists():
        read_marker(source / SOURCE_MARKER, expected, optional=("breezer_commit", "breezer_overlays"))
        print(f"Reusing prepared Windows sources in {source}", flush=True)
        return

    info, cache, components = fetch_sources(build_dir, core, platform, expected)
    stage = Path(tempfile.mkdtemp(prefix="src-preparing-", dir=build_dir))
    print(f"Preparing Windows sources in {stage}", flush=True)
    downloads.unpack_downloads(info, cache, components, stage,
                               {ExtractorEnum.SEVENZIP: USE_REGISTRY})
    prune_binaries.prune_dirs(stage, False, None, keep_build_dependencies=True)
    pruning_list = (core / "pruning.list").read_text(encoding="utf-8").splitlines()
    prune_binaries.prune_files(stage, filter(None, pruning_list), keep_build_dependencies=True)
    apply_helium_patches(stage, core, platform, stage / "third_party/git/usr/bin/patch.exe")
    domain_substitution.apply_substitution(core / "domain_regex.list",
                                           core / "domain_substitution.list", stage, None)
    name_substitution.do_substitution(stage, tarpath=None, workers=min(32, os.cpu_count() or 1),
                                      dry_run=False)
    i18n_apply.apply_translations(stage)
    version_file = stage / "chrome/VERSION"
    helium_version.check_existing_version(version_file)
    with version_file.open("a", encoding="utf-8") as stream:
        for name, version in helium_version.get_version_parts(core, platform).items():
            helium_version.append_version(stream, name, version)
    copy_helium_resources(stage, core, platform, build_dir)
    run(sys.executable, stage / "build/config/siso/configure_siso.py",
        "--rbe_instance=projects/rbe-chrome-untrusted/instances/default_instance",
        "--reapi_address=", "--reapi_instance=", "--reapi_backend_config_path=")
    write_marker(stage / SOURCE_MARKER, expected)
    stage.rename(source)
    print(f"Prepared Windows sources in {source}", flush=True)


def visual_studio_environment():
    program_files = Path(os.environ["ProgramFiles(x86)"])
    vswhere = program_files / "Microsoft Visual Studio/Installer/vswhere.exe"
    if not vswhere.is_file():
        raise FileNotFoundError(f"Visual Studio Installer is missing: {vswhere}")
    result = run(vswhere, "-products", "*", "-latest", "-utf8", "-version", "[18.0,)",
                 "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                 "Microsoft.VisualStudio.Component.VC.ATLMFC",
                 "-property", "installationPath", capture_output=True, encoding="utf-8")
    installation = result.stdout.strip()
    vcvars = Path(installation) / "VC/Auxiliary/Build/vcvars64.bat"
    if not installation or not vcvars.is_file():
        raise FileNotFoundError("Install Visual Studio 2026 x64 C++ build tools with ATL/MFC.")

    # Keep the path in an environment variable so cmd does not reinterpret it as flags.
    vcvars_env = {**os.environ, "BREEZER_VCVARS": str(vcvars)}
    comspec = os.environ.get("COMSPEC", "cmd.exe")
    command = f'"{comspec}" /d /u /s /c "call "%BREEZER_VCVARS%" 10.0.28000.0 >nul && set"'
    result = subprocess.run(command, env=vcvars_env, stdout=subprocess.PIPE)
    env = dict(line.split("=", 1) for line in result.stdout.decode("utf-16-le").splitlines()
               if "=" in line and not line.startswith("="))
    if result.returncode or not any(key.upper() == "VCTOOLSINSTALLDIR" for key in env):
        raise ValueError(f"Failed to initialize Visual Studio with Windows SDK 10.0.28000.0: {vcvars}")
    env.pop("BREEZER_VCVARS", None)
    env["DEPOT_TOOLS_WIN_TOOLCHAIN"] = "0"
    env["GYP_MSVS_VERSION"] = "2026"
    env["vs2026_install"] = installation
    env["PYTHONUTF8"] = "1"
    return env


def require_x64_pe(path):
    with path.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError(f"Invalid Windows executable: {path}")
        stream.seek(0x3C)
        offset = struct.unpack("<I", stream.read(4))[0]
        stream.seek(offset)
        if stream.read(6) != b"PE\0\0\x64\x86":
            raise ValueError(f"Expected an x64 Windows executable: {path}")


def build_browser(build_dir, core, platform, expected, jobs, gen_only, *, use_ninja=False):
    source = build_dir / "src"
    breezer = breezer_inputs()
    read_marker(source / SOURCE_MARKER, expected, optional=tuple(breezer))
    output = source / "out/Default"
    output.mkdir(parents=True, exist_ok=True)
    (output / BUILD_MARKER).unlink(missing_ok=True)
    env = visual_studio_environment()

    record_overlays(source / SOURCE_MARKER, expected, breezer)
    run(sys.executable, ROOT / "script/windows/apply_breezer_windows.py", source, cwd=ROOT,
        env={**os.environ, "PYTHONUTF8": "1"})

    flags = (core / "flags.gn").read_text(encoding="utf-8").rstrip()
    windows_flags = (platform / "flags.windows.gn").read_text(encoding="utf-8").rstrip()
    if use_ninja:
        windows_flags = re.sub(r"(?m)^[ \t]*use_siso[ \t]*=.*\n?", "", windows_flags).rstrip()
        windows_flags += "\nuse_siso=false"
    (output / "args.gn").write_text(
        f"{flags}\n{windows_flags}\nis_official_build=true\n", encoding="utf-8",
    )
    if not gen_only:
        stage_breezer_ai.stage(source / stage_breezer_ai.GN_PAYLOAD_DIRECTORY,
                               build_dir / "cache/breezer-ai-runtime")
    run(source / "buildtools/win/gn.exe", "gen", "out/Default", "--fail-on-unused-args",
        f"--script-executable={sys.executable}", cwd=source, env=env)
    if gen_only:
        return
    if use_ninja:
        runner = (source / "third_party/ninja/ninja.exe",)
    else:
        env["SISO_PATH"] = str(source / "third_party/siso/cipd/siso.exe")
        runner = (sys.executable, source / "third_party/depot_tools/autoninja.py")
    ninja_args = ("-j", str(jobs)) if jobs else ()
    run(*runner, *ninja_args,
        "-C", "out/Default", "chrome", "chromedriver", "setup", "mini_installer", cwd=source, env=env)
    for name in ("chrome.exe", "chrome.dll", "setup.exe", "mini_installer.exe"):
        require_x64_pe(output / name)
    require_x64_pe(output / stage_breezer_ai.LAUNCHER)
    require_x64_pe(output / stage_breezer_ai.NODE)
    write_marker(output / BUILD_MARKER, {**expected, **breezer})


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_browser(build_dir, destination, expected):
    import filescfg

    source = build_dir / "src"
    output = source / "out/Default"
    breezer = breezer_inputs()
    built = read_marker(output / BUILD_MARKER, expected, optional=tuple(breezer))
    if built.get("breezer_commit") != breezer["breezer_commit"]:
        raise ValueError(f"This build was compiled from Breezer commit {built.get('breezer_commit', 'unknown')}, "
                         f"but the checkout is at {breezer['breezer_commit']}. Build again before packaging.")
    if built.get("breezer_overlays") != breezer["breezer_overlays"]:
        raise ValueError("Breezer overlay inputs changed since this build. Build again before packaging.")
    if destination.exists():
        raise FileExistsError(f"Choose a new output directory: {destination}")
    for name in ("chrome.exe", "chrome.dll", "mini_installer.exe"):
        require_x64_pe(output / name)
    require_x64_pe(output / stage_breezer_ai.LAUNCHER)
    require_x64_pe(output / stage_breezer_ai.NODE)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="packaging-", dir=destination.parent) as temporary:
        stage = Path(temporary) / "artifacts"
        stage.mkdir()
        installer = stage / INSTALLER
        portable = stage / PORTABLE
        shutil.copyfile(output / "mini_installer.exe", installer)
        files = set(filescfg.filescfg_generator(source / "chrome/tools/build/win/FILES.cfg",
                                                output, "64bit", PORTABLE_EXCLUSIONS))
        files.update(path.relative_to(output) for path in (output / "locales").glob("*.pak")
                     if path.is_file())
        ai_files = stage_breezer_ai.package_files()
        if missing := {path for path in ai_files if not (output / path).is_file()}:
            raise ValueError(f"Missing Windows AI payload: {', '.join(path.as_posix() for path in sorted(missing))}")
        files.update(ai_files)
        filescfg.create_archive(sorted(files), (), output, portable)
        with ZipFile(portable) as archive:
            required = {f"{portable.stem}/{name}" for name in (
                "chrome.exe", "chrome.dll", "chrome_elf.dll", "chrome_100_percent.pak", "chrome_200_percent.pak",
                "icudtl.dat", "resources.pak", "locales/en-US.pak", "v8_context_snapshot.bin",
            )}
            required.update(f"{portable.stem}/{file.as_posix()}" for file in ai_files)
            if missing := required.difference(entry.filename for entry in archive.infolist()
                                              if entry.file_size > 0):
                raise ValueError(f"Missing portable files: {', '.join(sorted(missing))}")
            if (corrupt := archive.testzip()) is not None:
                raise ValueError(f"Portable archive integrity check failed at {corrupt}.")
        for artifact in (installer, portable):
            artifact.with_name(artifact.name + ".sha256").write_text(
                f"{sha256(artifact)}  {artifact.name}\n", encoding="ascii", newline="\n",
            )
        stage.rename(destination)
    print(f"Windows installer, ZIP and SHA-256 checksums are in {destination}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--build-dir", type=Path, default=ROOT / "build/windows-x64",
                        help="Dedicated build directory with room for Chromium sources and outputs")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("fetch", parents=[common], help="Download and verify build inputs")
    commands.add_parser("prepare", parents=[common], help="Create the patched Helium Windows source tree")
    build = commands.add_parser("build", parents=[common], help="Apply Breezer changes and compile")
    build.add_argument("-j", "--jobs", type=int, help="Limit simultaneous build jobs")
    build.add_argument("--gen-only", action="store_true", help="Generate the build graph and exit")
    build.add_argument("--ninja", action="store_true", help="Use Chromium's bundled Ninja instead of Siso")
    package = commands.add_parser("package", parents=[common], help="Package a completed Windows build")
    package.add_argument("--output-dir", type=Path, help="New output directory (default: BUILD_DIR/artifacts)")
    args = parser.parse_args()
    if args.command in {"prepare", "build"} and sys.platform != "win32":
        parser.error(f"{args.command} must run on Windows")
    if args.command == "build" and args.jobs is not None and args.jobs < 1:
        parser.error("--jobs must be at least one")

    lock = load_lock()
    core = ROOT / lock["helium"]["path"]
    sys.path.insert(0, str(core / "utils"))
    build_dir = args.build_dir.resolve()
    expected = prepared_inputs(lock)
    try:
        with build_lock(build_dir):
            if args.command == "package":
                destination = (args.output_dir or build_dir / "artifacts").resolve()
                package_browser(build_dir, destination, expected)
                return
            platform = platform_checkout(build_dir, lock)
            if args.command == "fetch":
                fetch_sources(build_dir, core, platform, expected)
            elif args.command == "prepare":
                prepare_sources(build_dir, core, platform, expected)
            elif args.command == "build":
                build_browser(build_dir, core, platform, expected, args.jobs, args.gen_only,
                              use_ninja=args.ninja)
    except (ImportError, KeyError, OSError, ValueError, struct.error, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Windows build {args.command} failed: {error}\n")


if __name__ == "__main__":
    main()
