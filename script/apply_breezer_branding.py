#!/usr/bin/env python3
"""Apply Breezer's identity to a prepared Chromium build tree."""

import argparse
import importlib
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "upstream.lock.json").read_text())
CORE = ROOT / LOCK["helium"]["path"]
BUNDLE_ID = "io.github.etphli.breezer"


def replace_file(path, replacements):
    text = path.read_text()
    for before, after in replacements.items():
        if before not in text and after not in text:
            raise ValueError(f"Branding input changed in {path}: {before!r}")
        text = text.replace(before, after)
    path.write_text(text)


def brand_product(tree):
    branding = tree / "chrome/app/theme/chromium/BRANDING"
    values = {
        "COMPANY_FULLNAME": "Breezer contributors",
        "COMPANY_SHORTNAME": "Breezer contributors",
        "PRODUCT_FULLNAME": "Breezer",
        "PRODUCT_SHORTNAME": "Breezer",
        "PRODUCT_INSTALLER_FULLNAME": "Breezer Installer",
        "PRODUCT_INSTALLER_SHORTNAME": "Breezer Installer",
        "MAC_BUNDLE_ID": BUNDLE_ID,
        "MAC_TEAM_ID": "",
    }
    lines = branding.read_text().splitlines()
    keys = {line.split("=", 1)[0] for line in lines if "=" in line}
    if not values.keys() <= keys:
        raise ValueError("The Chromium BRANDING input is missing expected keys.")
    branding.write_text("\n".join(
        f"{key}={values[key]}" if (key := line.split("=", 1)[0]) in values else line
        for line in lines
    ) + "\n")
    replace_file(tree / "chrome/common/chrome_paths_mac.mm", {
        "net.imput.helium": BUNDLE_ID,
    })
    replace_file(tree / "components/os_crypt/common/keychain_password_mac.mm", {
        '"Helium Storage Key"': '"Breezer Storage Key"',
        'kDefaultAccountName[] = "Helium"': 'kDefaultAccountName[] = "Breezer"',
    })
    replace_file(tree / "chrome/app/chrome_crash_reporter_client.cc", {
        'const char* product_name = "Helium"': 'const char* product_name = "Breezer"',
    })


def brand_strings(tree):
    sys.path.insert(0, str(CORE / "utils"))
    substitution = importlib.import_module("name_substitution")
    utility = importlib.import_module("name_substitution_utils")
    original_regexes = utility.REPLACEMENT_REGEXES
    original_message = utility.replace_grit_message
    original_translation = utility.replace_xtb_translation
    protected_fingerprints = set()

    def replace_message(message):
        name = message.get("name", "")
        if any(word in name for word in ("PARTNER", "LICENSE", "CREDITS", "LEGAL", "WELCOME_TERMS")):
            protected_fingerprints.add(str(utility.compute_fp(message)))
            return False
        return original_message(message)

    def replace_translation(message, fingerprints):
        if message.get("id") in protected_fingerprints:
            return False
        return original_translation(message, fingerprints)

    try:
        utility.REPLACEMENT_REGEXES = [
            (re.compile(r"\bHelium\b(?!\s+(?:services|servers|Authors|[Pp]artners?)\b)"), "Breezer"),
        ]
        utility.replace_grit_message = replace_message
        utility.replace_xtb_translation = replace_translation
        utility.add_grit_to_path(tree)
        results = []
        for path in substitution.get_substitutable_files(tree, ["grd", "grdp"]):
            result = substitution.substitute_grit_file((path, tree, False, False))
            if result is not None:
                results.append(result)
        fingerprints = utility.merge_fp_maps(results)
        for path in substitution.get_substitutable_files(tree, ["xtb"]):
            substitution.substitute_xtb_file((path, tree, fingerprints, False, False))
    finally:
        utility.REPLACEMENT_REGEXES = original_regexes
        utility.replace_grit_message = original_message
        utility.replace_xtb_translation = original_translation


def brand_onboarding(tree):
    onboarding = tree / "components/helium_onboarding"
    replace_file(onboarding / "index.html", {
        "<title>Helium Setup</title>": "<title>Breezer Setup</title>",
    })
    for page in ("Welcome.svelte", "Finish.svelte"):
        path = onboarding / "src/pages" / page
        text = path.read_text()
        text, count = re.subn(
            r'<HeliumLogo height="(\d+)px"\s*/>',
            r'<img src="/breezer-logo.png" alt="Breezer" height="\1" width="\1" />',
            text,
        )
        if not count and 'alt="Breezer"' not in text:
            raise ValueError(f"The onboarding logo input changed: {path}")
        text = re.sub(r"^[ \t]*HeliumLogo,\r?\n", "", text, flags=re.MULTILINE)
        path.write_text(text)
    logo = ROOT / "assets/branding/breezer-logo.png"
    shutil.copyfile(logo, onboarding / "public/breezer-logo.png")
    scale(logo, 32, onboarding / "public/favicon.png")


def scale(logo, size, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["sips", "-z", str(size), str(size), str(logo), "--out", str(target)],
        check=True, stdout=subprocess.DEVNULL,
    )


def brand_icons(tree):
    logo = ROOT / "assets/branding/breezer-logo.png"
    output = ROOT / "build/branding"
    iconset = output / "Breezer.iconset"
    catalog = output / "Assets.xcassets"
    appicon = catalog / "AppIcon.appiconset"
    images = []
    for size in (16, 32, 128, 256, 512):
        for factor in (1, 2):
            name = f"icon_{size}x{size}" + ("@2x" if factor == 2 else "") + ".png"
            scale(logo, size * factor, iconset / name)
            appicon.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(iconset / name, appicon / name)
            images.append({"filename": name, "idiom": "mac", "size": f"{size}x{size}", "scale": f"{factor}x"})
    (appicon / "Contents.json").write_text(json.dumps({
        "images": images, "info": {"author": "xcode", "version": 1},
    }, indent=2) + "\n")
    (catalog / "Contents.json").write_text('{"info":{"author":"xcode","version":1}}\n')
    mac = tree / "chrome/app/theme/chromium/mac"
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(mac / "app.icns")], check=True)
    subprocess.run([
        "xcrun", "actool", str(catalog), "--compile", str(mac),
        "--platform", "macosx", "--minimum-deployment-target", "12.0",
        "--app-icon", "AppIcon", "--output-partial-info-plist", str(output / "icon-info.plist"),
    ], check=True)

    for line in (CORE / "resources/helium_resources.txt").read_text().splitlines():
        parts = line.split()
        if len(parts) != 2 or not parts[0].endswith(".png"):
            continue
        if not parts[0].startswith(("branding/product_logo", "generated/product_icon/")):
            continue
        target = tree / parts[1]
        header = target.read_bytes()[:24]
        if header[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"Expected a PNG branding target: {target}")
        width, height = struct.unpack(">II", header[16:24])
        if width != height:
            raise ValueError(f"Expected a square branding target: {target}")
        scale(logo, width, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_tree", type=Path)
    args = parser.parse_args()
    tree = args.source_tree.resolve()
    if not (tree / "OWNERS").is_file() or not (tree / "tools/grit").is_dir():
        parser.error("Use the prepared Chromium source tree, after applying upstream patches.")
    brand_product(tree)
    brand_strings(tree)
    brand_onboarding(tree)
    brand_icons(tree)
    print("Breezer product identity, profile directory, Keychain names, UI strings, and app icons prepared.")


if __name__ == "__main__":
    main()
