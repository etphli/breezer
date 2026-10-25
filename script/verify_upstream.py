#!/usr/bin/env python3
"""Verify the complete imported Helium snapshots against their original commits."""

import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=ROOT).decode().strip()


def entries(tree):
    records = subprocess.check_output(["git", "ls-tree", "-z", tree], cwd=ROOT)
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

    core_tree = git("rev-parse", f'{core["commit"]}^{{tree}}')
    imported_core_tree = git("rev-parse", f'HEAD:{core["path"]}')
    if core_tree != imported_core_tree:
        raise ValueError("The imported Helium core differs from the pinned source.")

    expected_platform = entries(platform["commit"])
    if expected_platform["helium-chromium"] != f'160000 commit {core["commit"]}':
        raise ValueError("The pinned core does not match the macOS release's submodule.")
    expected_platform["helium-chromium"] = f"040000 tree {core_tree}"
    if expected_platform != entries(f'HEAD:{platform["path"]}'):
        raise ValueError("The imported macOS source differs from the pinned source.")

    subprocess.run(
        ["git", "diff", "--exit-code", "--quiet", "HEAD", "--", platform["path"]],
        cwd=ROOT, check=True,
    )
    paths = git("ls-tree", "-r", "--name-only", f'HEAD:{platform["path"]}').splitlines()
    tests = [path for path in paths if Path(path).name.startswith("test_")]
    print(f"PASS: all {len(paths)} upstream files match their original Git objects.")
    print(f"PASS: {len(tests)} test modules, licences, workflows, and full histories retained.")
    print("PASS: the macOS submodule is embedded as its complete, matching source tree.")


if __name__ == "__main__":
    try:
        main()
    except (subprocess.CalledProcessError, ValueError) as error:
        print(f"Upstream verification failed: {error}", file=sys.stderr)
        sys.exit(1)
