"""Stage the Windows AI host files and include them in the mini installer."""

from pathlib import Path
import filecmp
import json
import shutil
import sys
import tempfile
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from apply_breezer_ai import replace
from package_breezer_ai import FEATURE, download_runtime, verify_archive


PAYLOAD = Path("breezer_ai")
LAUNCHER = PAYLOAD / "breezer_ai_host.exe"
NODE = PAYLOAD / "runtime/node.exe"
LICENSE = PAYLOAD / "runtime/LICENSE"
MANIFEST = PAYLOAD / "io.github.etphli.breezer.ai.json"
GN_PAYLOAD_DIRECTORY = Path("components/breezer_ai_windows/payload")
GN_INSTALLER = "chrome/installer/mini_installer/BUILD.gn"
RELEASE = "chrome/installer/mini_installer/chrome.release"


def host_files():
    return {PAYLOAD / "host" / path.name: path
            for path in sorted((FEATURE / "host").glob("*.mjs"))}


def package_files():
    return {LAUNCHER, NODE, LICENSE, MANIFEST, *host_files()}


def stage(output, cache):
    """Stage exactly the first-party script files and pinned Node distribution."""
    lock = json.loads((FEATURE / "runtime.lock.json").read_text(encoding="utf-8"))
    distribution = lock["distributions"]["win-x64"]
    archive = download_runtime(distribution, cache)
    prefix = distribution["filename"].removesuffix(".zip")
    cp = {MANIFEST: FEATURE / "windows/native-host-manifest.json", **host_files()}
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="breezer-ai-", dir=output) as temporary:
        staged = Path(temporary)
        for name, original in cp.items():
            (staged / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, staged / name)
        (staged / NODE).parent.mkdir(parents=True, exist_ok=True)
        with ZipFile(archive) as source:
            for name in (NODE, LICENSE):
                member = source.getinfo(f"{prefix}/{name.name}")
                with source.open(member) as data, (staged / name).open("wb") as target:
                    shutil.copyfileobj(data, target)
        verify_archive(staged / NODE, distribution["exe_sha256"])
        for name in (*cp, NODE, LICENSE):
            target = output / name
            if target.is_file() and filecmp.cmp(staged / name, target, shallow=False):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            (staged / name).replace(target)


def configure_installer(source):
    files = sorted(package_files())
    release = source / RELEASE
    header, general, contents = release.read_text(encoding="utf-8").partition("[GENERAL]\n")
    begin, end = "# Breezer AI payload\n", "# End of Breezer AI payload\n"
    if not general or (contents.startswith(begin) and end not in contents):
        raise ValueError(f"Unexpected Windows installer manifest at {release}")
    if contents.startswith(begin):
        contents = contents.partition(end)[2]
    entries = []
    for path in files:
        name = "\\".join(path.parts)
        directory = "\\".join(path.parent.parts)
        entries.append(f"{name}: %(VersionDir)s\\{directory}\\\n")
    release.write_text(header + general + begin + "".join(entries) + end + contents,
                       encoding="utf-8", newline="\n")
    relative = "\n".join(f'  "{path.as_posix()}",' for path in files if path != LAUNCHER)
    (source / "components/breezer_ai_windows/installer_files.gni").write_text(
        f"breezer_ai_staged_files = [\n{relative}\n]\n"
        f'breezer_ai_installer_files = breezer_ai_staged_files + [ "{LAUNCHER.as_posix()}" ]\n',
        encoding="utf-8", newline="\n",
    )
    replace(source, GN_INSTALLER, 'action("mini_installer_archive") {',
            'import("//components/breezer_ai_windows/installer_files.gni")\n\n'
            'action("mini_installer_archive") {')
    replace(source, GN_INSTALLER, "    release_file,\n  ]",
            '    release_file,\n  ]\n  foreach(file, breezer_ai_installer_files) {\n'
            '    inputs += [ "$root_out_dir/$file" ]\n  }')
    replace(source, GN_INSTALLER, '    ":chrome_runtime_deps",',
            '    ":chrome_runtime_deps",\n    "//components/breezer_ai_windows:breezer_ai_host",')
    replace(source, GN_INSTALLER, '    "//components/breezer_ai_windows:breezer_ai_host",',
            '    "//components/breezer_ai_windows:breezer_ai_host",\n'
            '    "//components/breezer_ai_windows:breezer_ai_payload",')
