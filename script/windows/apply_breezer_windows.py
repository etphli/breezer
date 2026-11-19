#!/usr/bin/env python3
"""Apply Breezer's Windows identity and shared features before generating GN."""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
from uuid import UUID

from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import apply_breezer_branding as branding
from breezer_release import release_version


ROOT = branding.ROOT
INSTALL_GUID = "45C7CD9E-F67A-4D78-AF9B-A190E6397F48"
ELEVATOR_IID = "B9CFA6CC-B530-43A3-B12F-B4FD782984C7"
TRACING_IID = "633CAC65-BCA7-4FAB-B0C9-C1AB5CEFEB13"
ICO_SIZES = [(size, size) for size in (16, 20, 24, 32, 40, 48, 64, 128, 256)]


def brand_version(tree):
    path = tree / "chrome/VERSION"
    lines = path.read_text(encoding="utf-8").splitlines()
    names = ("HELIUM_MAJOR", "HELIUM_MINOR", "HELIUM_PATCH", "HELIUM_PLATFORM")
    values = dict(zip(names, release_version(ROOT).split(".") + ["0"]))
    if any(sum(line.startswith(f"{key}=") for line in lines) != 1 for key in names):
        raise ValueError(f"Missing or duplicate Windows version fields in {path}")
    for index, line in enumerate(lines):
        key = line.partition("=")[0]
        if key in values:
            lines[index] = f"{key}={values[key]}"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def brand_install_modes(tree):
    path = tree / "chrome/install_static/chromium_install_modes.h"
    branding.replace_file(path, {
        'kCompanyPathName[] = L"imput"': 'kCompanyPathName[] = L""',
        'L"Helium': 'L"Breezer',
        'kSafeBrowsingName[] = "helium"': 'kSafeBrowsingName[] = "breezer"',
        '.direct_launch_url_scheme = "helium"': '.direct_launch_url_scheme = "breezer"',
        "{FB68A146-637A-48C2-A0C4-1565DE45FEBD}": "{" + INSTALL_GUID + "}",
        "{C89A04FF-00C6-4966-94B2-5AFEC6FED93A}": "{" + ELEVATOR_IID + "}",
        ".old_tracing_service_iids = kOldTracingServiceIids": ".old_tracing_service_iids = {}",
        'L"S-1-15-2-3251537155-1984446955-2931258699-841473695-"\n'
        '            L"1938553385-"\n'
        '            L"924012148-"': 'L"S-1-15-2-282615145-566473390-4247269207-356373751-"\n'
        '            L"33397094-2864306062-"',
    })
    identities = {
        "toast_activator_clsid": "755C8840-5526-48C3-8926-4C68BEBA0EDB",
        "elevator_clsid": "0DDCA1CA-12B9-48F3-9F01-D87F8C9BCE9F",
        "elevator_iid": ELEVATOR_IID,
        "tracing_service_clsid": "C500F6B4-7AE6-4E17-B5A7-E2C5C83252CD",
        "tracing_service_iid": TRACING_IID,
    }
    body = path.read_text(encoding="utf-8")
    for field, identity in identities.items():
        guid = UUID(identity)
        prefix = f"{{0x{guid.time_low:08x}, 0x{guid.time_mid:04x}, 0x{guid.time_hi_version:04x},"
        tail = ", ".join(f"0x{value:02x}" for value in guid.bytes[8:])
        replacement = f".{field} = {prefix}\n            {{{tail}}}}}"
        body, count = re.subn(rf"\.{field} = \{{[^{{}}]+\{{[^{{}}]+\}}\}}", replacement, body)
        if count != 1:
            raise ValueError(f"Expected one {field} initializer in {path}")
    path.write_text(body, encoding="utf-8", newline="\n")

    # Keep the registered interface identifiers in sync with the COM definitions.
    branding.replace_file(tree / "chrome/elevation_service/elevation_service_idl.idl", {
        "BB19A0E5-00C6-4966-94B2-5AFEC6FED93A": ELEVATOR_IID,
    })
    branding.replace_file(tree / "chrome/windows_services/elevated_tracing_service/tracing_service_idl.idl", {
        "E0B03E2D-7682-4D83-B9FF-4574AF720500": TRACING_IID,
    })
    for name, policy_prefix in (
        ("chrome/installer/setup/installer_crash_reporter_client.cc", r"Policies\\"),
        ("components/policy/tools/generate_policy_source.py", r"Policies\\\\"),
        ("components/policy/tools/template_writers/writer_configuration.py", r"Policies\\"),
    ):
        branding.replace_file(tree / name, {policy_prefix + "Helium": policy_prefix + "Breezer"})
    branding.replace_file(tree / "components/policy/tools/template_writers/writer_configuration.py", {
        "'app_name': 'Helium'": "'app_name': 'Breezer'",
        "'chromium': 'Helium'": "'chromium': 'Breezer'",
        "'chromium_recommended': 'Helium -": "'chromium_recommended': 'Breezer -",
    })
    branding.replace_file(tree / "chrome/installer/util/logging_installer.cc", {
        "helium_installer.log": "breezer_installer.log",
    })
    branding.replace_file(tree / "chrome/installer/mini_installer/mini_installer_constants.cc", {
        r'L"Software\\Chromium"': r'L"Software\\Breezer"',
    })


def brand_icons(tree):
    icons = tree / "chrome/app/theme/chromium/win"
    with Image.open(ROOT / "assets/branding/breezer-logo.png") as source:
        icon = source.convert("RGBA")
    icon.save(icons / "chromium.ico", sizes=ICO_SIZES)
    document = Image.new("RGBA", (256, 256))
    draw = ImageDraw.Draw(document)
    draw.rounded_rectangle((43, 16, 213, 240), radius=20, fill="#fffdf7", outline="#5b6b6c", width=8)
    document.alpha_composite(ImageOps.contain(icon, (154, 154), Image.Resampling.LANCZOS), (51, 63))
    for name in ("chromium_doc.ico", "chromium_pdf.ico"):
        document.save(icons / name, sizes=ICO_SIZES)
    for name in ("Logo.png", "SmallLogo.png"):
        branding.brand_resource_png(ROOT / "assets/branding/breezer-logo.png", icons / "tiles" / name)
    branding.brand_shared_icons(tree)


def apply_import_patch(tree):
    patch = ROOT / "features/passwords/native-ui/windows-import.patch"
    patch_data = patch.read_text(encoding="utf-8").encode("utf-8")
    command = ["git", "-c", "core.autocrlf=false", "apply", "--whitespace=nowarn"]
    env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(tree.parent)}
    if subprocess.run([*command, "--reverse", "--check", "-"], cwd=tree,
                      input=patch_data, env=env, capture_output=True).returncode != 0:
        subprocess.run([*command, "-"], cwd=tree, input=patch_data, env=env, check=True)


def apply(tree):
    branding.brand_product(tree, macos=False)
    brand_version(tree)
    brand_install_modes(tree)
    branding.brand_strings(tree)
    branding.brand_onboarding(tree, native_icons=False)
    brand_icons(tree)

    patch_dir = tree / "third_party/git/usr/bin"
    env = {**os.environ, "PATH": str(patch_dir) + os.pathsep + os.environ["PATH"], "PYTHONUTF8": "1"}
    for script, options in (
        ("script/apply_breezer_ai.py", ("--platform", "windows")),
        ("script/apply_breezer_omnibox.py", ()),
        ("script/apply_breezer_workspace.py", ()),
        ("script/apply_breezer_ai_ui.py", ()),
        ("features/passwords/native-ui/apply.py", ()),
        ("script/apply_breezer_sync.py", ()),
    ):
        subprocess.run([sys.executable, ROOT / script, *options, tree], env=env, check=True)
    apply_import_patch(tree)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_tree", type=Path)
    args = parser.parse_args()
    apply(args.source_tree.resolve())
