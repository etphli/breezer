#!/usr/bin/env python3
"""Verify the complete imported Helium snapshots against their original commits."""

import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent


def entries(tree, recursive=False):
    arguments = ["git", "ls-tree", "-z"]
    if recursive:
        arguments.append("-r")
    records = subprocess.check_output([*arguments, tree], cwd=ROOT)
    result = {}
    for record in records.split(b"\0"):
        if record:
            metadata, name = record.decode().split("\t", 1)
            result[name] = metadata
    return result


def main():
    lock = json.loads((ROOT / "upstream.lock.json").read_text())
    core = lock["helium"]
    platform = lock["helium_macos"]

    for source in (platform, core):
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", source["commit"], "HEAD"],
            cwd=ROOT, check=True,
        )

    platform_entries = entries(platform["commit"], recursive=True)
    if platform_entries.pop("helium-chromium") != f'160000 commit {core["commit"]}':
        raise ValueError("The pinned core does not match the macOS release's submodule.")

    expected = {f'{platform["path"]}/{name}': value for name, value in platform_entries.items()}
    expected.update({
        f'{core["path"]}/{name}': value
        for name, value in entries(core["commit"], recursive=True).items()
    })
    all_files = entries("HEAD", recursive=True)
    actual = {name: value for name, value in all_files.items() if name.startswith(platform["path"] + "/")}

    overrides = lock.get("documentation_overrides", {})
    for name, archive in overrides.items():
        if Path(name).name != "README.md":
            raise ValueError(f"Only README files can be documentation overrides: {name}")
        if all_files.get(archive) != expected[name]:
            raise ValueError(f"The original upstream document was not preserved: {archive}")
        if name not in actual:
            raise ValueError(f"The Breezer README is missing: {name}")
        if "Breezer" not in (ROOT / name).read_text():
            raise ValueError(f"The README does not identify Breezer: {name}")
        expected[name] = actual[name]

    if expected != actual:
        differences = [name for name in expected.keys() | actual.keys() if expected.get(name) != actual.get(name)]
        raise ValueError("Upstream source differs: " + ", ".join(sorted(differences)))

    subprocess.run(
        ["git", "diff", "--exit-code", "--quiet", "HEAD", "--", platform["path"], *overrides.values()],
        cwd=ROOT, check=True,
    )
    paths = list(actual)
    tests = [path for path in paths if Path(path).name.startswith("test_")]
    print(f"PASS: all {len(paths) - len(overrides)} upstream code and configuration files match their original Git objects.")
    print(f"PASS: {len(overrides)} READMEs describe Breezer, with exact upstream originals archived.")
    print(f"PASS: {len(tests)} test modules, licences, workflows, and full histories retained.")
    print("PASS: the macOS submodule is embedded as its complete, matching source tree.")


if __name__ == "__main__":
    try:
        main()
    except (subprocess.CalledProcessError, ValueError) as error:
        print(f"Upstream verification failed: {error}", file=sys.stderr)
        sys.exit(1)
