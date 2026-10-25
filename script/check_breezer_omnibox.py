#!/usr/bin/env python3
"""Check the omnibox overlay on pinned Chromium plus both Helium patch series.

Source/resource verification does not execute Chromium C++ or WebUI tests.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as xml

import apply_breezer_ai as ai
import apply_breezer_branding as branding
import apply_breezer_omnibox as omnibox
import check_ai_overlay as ai_check


ROOT = omnibox.ROOT
MANIFEST = json.loads((ROOT / "features/omnibox/upstream.json").read_text())
VERSION = MANIFEST["chromium_version"]
CACHE = ROOT / "build/omnibox-check" / VERSION / "pristine"
LABELS = {
    "IDS_SETTINGS_ADDRESS_BAR": "Address bar",
    "IDS_SETTINGS_LOCAL_SUGGESTIONS": "Local suggestions",
    "IDS_SETTINGS_LOCAL_SUGGESTIONS_SHOW_HISTORY": "Show browsing history",
    "IDS_SETTINGS_LOCAL_SUGGESTIONS_SHOW_BOOKMARKS": "Show bookmarks",
}


def prepare(tree, offline):
    lock = json.loads((ROOT / "upstream.lock.json").read_text())
    version_file = ROOT / lock["helium"]["path"] / "chromium_version.txt"
    if version_file.read_text().strip() != VERSION:
        raise ValueError("Re-review the omnibox overlay for the new Chromium version")
    for project in ("helium", "helium_macos"):
        if lock[project]["commit"] != MANIFEST[f"{project}_commit"]:
            raise ValueError(f"Re-review the omnibox overlay for the new {project} source")
    paths = omnibox.sections()

    def fetch(name):
        cached = CACHE / name
        if not cached.is_file():
            if offline:
                raise ValueError(f"Missing offline fixture: {name}")
            cached.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=cached.parent, delete=False) as output:
                temporary = Path(output.name)
            try:
                subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                                f"https://raw.githubusercontent.com/chromium/chromium/{VERSION}/{name}",
                                "--output", str(temporary)], check=True)
                temporary.replace(cached)
            finally:
                temporary.unlink(missing_ok=True)
        target = tree / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cached, target)

    with ThreadPoolExecutor(max_workers=6) as executor:
        list(executor.map(fetch, paths))
    for patch in ai_check.upstream_series():
        selected = []
        for section in ai_check.file_sections(patch):
            match = re.search(r"^\+\+\+ b/(\S+)", section, re.MULTILINE)
            if match and match[1] in paths:
                selected.append(section)
        if selected:
            result = subprocess.run(["patch", "--batch", "-p1", "-d", str(tree)],
                                    input="".join(selected), text=True, capture_output=True)
            if result.returncode:
                raise ValueError(f"Pinned upstream patch failed: {patch}\n{result.stdout}{result.stderr}")


def snapshot(tree):
    return {path.relative_to(tree).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in tree.rglob("*") if path.is_file() and not path.is_symlink()}


def expect_failure(operation):
    try:
        operation()
    except ValueError:
        return
    raise AssertionError("Expected the overlay to reject this source state")


def check_resources(tree, grit_directory):
    messages = xml.parse(tree / "chrome/app/settings_strings.grdp").getroot().findall(".//message")
    for name, label in LABELS.items():
        matching = [message for message in messages if message.get("name") == name]
        assert len(matching) == 1, f"Missing or duplicated label: {name}"
        assert "".join(matching[0].itertext()).strip() == label
    if not grit_directory:
        return
    resource = tree / "omnibox-test.grd"
    fragment = "\n".join(xml.tostring(message, encoding="unicode") for message in messages
                         if message.get("name") in LABELS)
    resource.write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<grit latest_public_release="0" current_release="1" source_lang_id="en">
  <outputs>
    <output filename="omnibox_strings.h" type="rc_header" />
    <output filename="omnibox_strings.pak" type="data_package" lang="en" />
  </outputs>
  <release seq="1"><messages first_id="1000">{fragment}</messages></release>
</grit>''')
    output = tree / "omnibox-test-resources"
    subprocess.run([sys.executable, str(grit_directory / "grit.py"), "-i", str(resource),
                    "build", "-o", str(output)], check=True)
    sys.path.insert(0, str(grit_directory))
    from grit.format import data_pack
    header = (output / "omnibox_strings.h").read_text()
    packed = data_pack.ReadDataPack(str(output / "omnibox_strings.pak"))
    for name, label in LABELS.items():
        identifier = int(re.search(rf"#define {name} (\d+)", header)[1])
        encoding = "utf-8" if packed.encoding == data_pack.UTF8 else "utf-16-le"
        assert packed.resources[identifier].decode(encoding) == label


def check(tree, grit_directory):
    paths = omnibox.sections()
    assert not set(paths).intersection(ai.PATCHED_FILES), "Coordinate any shared AI targets before porting"
    if grit_directory:
        (tree / "tools").mkdir(exist_ok=True)
        (tree / "tools/grit").symlink_to(grit_directory, target_is_directory=True)
        branding.brand_strings(tree)
    ai.apply(tree)
    original = {name: (tree / name).read_bytes() for name in paths}
    before = snapshot(tree)
    expect_failure(lambda: omnibox.apply(tree, check=True))
    assert snapshot(tree) == before, "--check wrote to unprepared source"
    assert omnibox.apply(tree) == len(paths)
    applied = snapshot(tree)
    assert omnibox.apply(tree) == 0
    assert omnibox.apply(tree, check=True) == 0
    ai.apply(tree)
    assert snapshot(tree) == applied, "Repeated AI/omnibox preparation changed source"
    for name in paths:
        if name.endswith(("_unittest.cc", "_test.ts")):
            pattern = rb"(?:TEST_[FP]\([^\n]+|  test\('[^']+)"
            assert set(re.findall(pattern, original[name])).issubset(
                set(re.findall(pattern, (tree / name).read_bytes()))), f"An upstream test was lost: {name}"
    # An interrupted update can leave whole files either old or new.
    first = next(iter(paths))
    (tree / first).write_bytes(original[first])
    assert omnibox.apply(tree) == 1
    assert snapshot(tree) == applied
    # A later unknown file must not leave earlier targets partially modified.
    last = list(paths)[-1]
    last_applied = (tree / last).read_bytes()
    (tree / first).write_bytes(original[first])
    (tree / last).write_text("// Simulated upstream drift\n")
    drifted = snapshot(tree)
    expect_failure(lambda: omnibox.apply(tree))
    assert snapshot(tree) == drifted, "Anchor failure modified real source"
    (tree / last).write_bytes(last_applied)
    omnibox.apply(tree)
    assert snapshot(tree) == applied
    check_resources(tree, grit_directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--grit-directory", type=Path,
                        help="Pinned Chromium tools/grit: also check branding and compile the four new labels")
    args = parser.parse_args()
    grit = args.grit_directory.resolve() if args.grit_directory else None
    with tempfile.TemporaryDirectory(prefix="breezer-omnibox-check-") as directory:
        tree = Path(directory).resolve()
        ai_check.prepare(tree, args.offline)
        prepare(tree, args.offline)
        check(tree, grit)
    print(f"PASS: Chromium {VERSION} plus both pinned Helium patch series; {len(omnibox.sections())} targets.")
    print("PASS: apply/check, idempotence, interrupted-file recovery, no writes on anchor failure, AI reapplication, retained upstream tests, unique settings labels.")
    if grit:
        print("PASS: actual Breezer string branding and pinned GRIT compilation/PAK contents for all four new labels.")
    print("Native C++ tests, Chromium WebUI tests, and browser behavior still require a compiled build.")


if __name__ == "__main__":
    main()
