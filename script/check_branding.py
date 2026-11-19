#!/usr/bin/env python3
"""Check Breezer branding against the pinned Chromium GRIT implementation."""

import argparse
import importlib
from pathlib import Path
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as xml

from PIL import Image

import apply_breezer_branding as branding


def check_native(tree, offline):
    from check_ai_overlay import prepare

    protocol_patch = branding.CORE / "patches/helium/core/override-chrome-protocol.patch"
    targets = set(re.findall(r"^\+\+\+ b/(.+)$", protocol_patch.read_text(), re.MULTILINE))
    targets.update({
        "chrome/browser/helium_flag_entries.h",
        "chrome/browser/ui/toolbar/chrome_location_bar_model_delegate.cc",
        "components/extstore_fixups/chrome-webstore.js",
        "components/helium_services/schema.cc",
        "components/omnibox/browser/BUILD.gn",
        "ui/webui/resources/cr_elements/icons.html.ts",
    })
    prepare(tree, offline, wanted_paths=targets)

    resources = branding.CORE / "resources"
    vector_paths = {}
    for source, destination in branding.branding_resources():
        if source.endswith((".icon", ".svg")):
            path = tree / destination
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(resources / source, path)
            vector_paths[path] = resources / source

    apply = (branding.brand_internal_urls, branding.brand_native_labels, branding.brand_vector_icons)
    for operation in apply:
        operation(tree)
    constants = (tree / "content/public/common/url_constants.h").read_text()
    assert 'kChromeUIScheme[] = "chrome"' in constants
    assert 'kBreezerUIScheme[] = "breezer"' in constants
    assert 'kLegacyHeliumUIScheme[] = "helium"' in constants
    navigator = (tree / "chrome/browser/ui/navigator/browser_navigator.cc").read_text()
    assert "params->url.SchemeIs(content::kBreezerUIScheme) ||" in navigator
    assert "params->url.SchemeIs(content::kLegacyHeliumUIScheme)" in navigator
    assert "replacements.SetSchemeStr(content::kChromeUIScheme)" in navigator
    for file in ("components/omnibox/browser/omnibox_text_util.cc", "components/url_formatter/url_formatter.cc"):
        assert "replacements.SetSchemeStr(content::kBreezerUIScheme)" in (tree / file).read_text()
    assert "document.createTextNode('breezer://')" in (
        tree / "chrome/browser/resources/tab_search/tab_search_item.ts"
    ).read_text()
    suggestions = (tree / "components/omnibox/browser/builtin_provider.cc").read_text()
    assert "url_formatter::IsEquivalentScheme(url.GetScheme(), embedder_scheme)" in suggestions
    assert "if (!matching_scheme ||" in suggestions

    for native_logo, old_logo in vector_paths.items():
        assert native_logo.read_bytes() != old_logo.read_bytes(), f"Retained a Helium logo in {native_logo}"
    star = tree / "components/omnibox/browser/vector_icons/internal_page.icon"
    assert star.read_bytes() == (resources / "branding/product_logo.icon").read_bytes()
    assert '"internal_page.icon"' in (tree / "components/omnibox/browser/BUILD.gn").read_text()
    delegate = (tree / "chrome/browser/ui/toolbar/chrome_location_bar_model_delegate.cc").read_text()
    assert "return &omnibox::kInternalPageIcon;" in delegate
    assert "Helium flag" not in (tree / "chrome/browser/helium_flag_entries.h").read_text()

    before = {path: path.read_bytes() for path in tree.rglob("*") if path.is_file()}
    for operation in apply:
        operation(tree)
    assert before == {path: path.read_bytes() for path in before}, "Native branding is not repeatable."
    print("PASS: pinned internal URLs, legacy aliases, native and WebUI product art, and the address-bar star.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("grit_directory", type=Path)
    parser.add_argument("--native", action="store_true", help="Apply branding to pinned Chromium fixtures")
    parser.add_argument("--offline", action="store_true", help="Use the cached Chromium fixtures with --native")
    args = parser.parse_args()
    sys.path.insert(0, str(branding.CORE / "utils"))
    utility = importlib.import_module("name_substitution_utils")

    with tempfile.TemporaryDirectory(prefix="breezer-branding-") as directory:
        tree = Path(directory)
        (tree / "tools").mkdir()
        (tree / "tools/grit").symlink_to(args.grit_directory.resolve(), target_is_directory=True)
        utility.add_grit_to_path(tree)
        source = xml.fromstring('''<grit-part>
          <message name="IDS_TEST_WELCOME">Meet Helium</message>
          <message name="IDS_TEST_PARTNER_TOOLTIP">This supports the development of Helium.</message>
          <message name="IDS_TEST_SERVICES">Helium services</message>
        </grit-part>''')
        ids = [str(utility.compute_fp(message)) for message in source]
        (tree / "messages.grdp").write_text(xml.tostring(source, encoding="unicode"))
        translations = xml.Element("translationbundle", {"lang": "de"})
        texts = ["Hallo Helium", "Dies unterstützt die Entwicklung von Helium.", "Helium services"]
        for identifier, text in zip(ids, texts):
            xml.SubElement(translations, "translation", {"id": identifier}).text = text
        (tree / "messages.xtb").write_text(xml.tostring(translations, encoding="unicode"))

        branding.brand_strings(tree)
        assert not (tree / "messages.grdp").read_text().startswith("<?xml"), "GRDP fragments must retain their original header format."
        messages = xml.parse(tree / "messages.grdp").getroot()
        translated = xml.parse(tree / "messages.xtb").getroot()
        assert messages[0].text == "Meet Breezer"
        assert messages[1].text == "This supports the development of Helium.", "Upstream funding credit was rebranded."
        assert messages[2].text == "Breezer services"
        assert translated[0].text == "Hallo Breezer"
        assert translated[0].get("id") == str(utility.compute_fp(messages[0]))
        assert translated[1].text == texts[1], "Translated funding credit was rebranded."
        assert translated[1].get("id") == ids[1]
        assert translated[2].text == "Breezer services"
        assert translated[2].get("id") == str(utility.compute_fp(messages[2]))

        before = {name: (tree / name).read_bytes() for name in ("messages.grdp", "messages.xtb")}
        branding.brand_strings(tree)
        assert before == {name: (tree / name).read_bytes() for name in before}, "Branding is not repeatable."

        onboarding = tree / "components/helium_onboarding"
        (onboarding / "public").mkdir(parents=True)
        (onboarding / "src/pages").mkdir(parents=True)
        (onboarding / "src/components").mkdir()
        (onboarding / "index.html").write_text("<title>Helium Setup</title>")
        for page in ("Welcome.svelte", "Finish.svelte"):
            (onboarding / "src/pages" / page).write_text(
                '    HeliumLogo,\n<HeliumLogo height="64px" />\n'
            )
        services = onboarding / "src/pages/HeliumServices.svelte"
        services.write_text('import { CardLink, HeliumLogo } from "@imput/helium-prism";\n'
                            '<PageHeader Icon={HeliumLogo} />\n')
        partner = onboarding / "src/components/HeliumPartner.svelte"
        partner.write_text('import { HeliumLogo, Tooltip }\n<HeliumLogo height="13px" />\n'
                           '    .helium-partner-badge {\n        display: flex;\n')
        branding.brand_onboarding(tree)
        applied = {path: path.read_bytes() for path in onboarding.rglob("*") if path.is_file()}
        branding.brand_onboarding(tree)
        assert applied == {path: path.read_bytes() for path in applied}, "Onboarding branding is not repeatable."
        assert "Icon={BreezerLogo}" in services.read_text()
        assert "<IconInfo />" in partner.read_text()
        assert "Breezer Setup" in (onboarding / "index.html").read_text()
        for page in ("Welcome.svelte", "Finish.svelte"):
            body = (onboarding / "src/pages" / page).read_text()
            assert 'alt="Breezer"' in body and "HeliumLogo" not in body
        assert (onboarding / "public/breezer-logo.png").read_bytes() == (
            branding.ROOT / "assets/branding/breezer-logo.png"
        ).read_bytes()
        for name in ("product_logo.png", "product_logo_white.png", "product_logo_200.png"):
            source = branding.CORE / "resources/branding" / name
            target = tree / name
            target.write_bytes(source.read_bytes())
            with Image.open(source) as original:
                original_size = original.size
            branding.brand_resource_png(branding.ROOT / "assets/branding/breezer-logo.png", target)
            with Image.open(target) as result:
                assert result.size == original_size, "Wide wordmark dimensions must stay unchanged."
                assert result.getbbox(), "The product wordmark must contain visible artwork."
            before = target.read_bytes()
            branding.brand_resource_png(branding.ROOT / "assets/branding/breezer-logo.png", target)
            assert before == target.read_bytes(), "PNG branding is not repeatable."
        if args.native:
            native = tree / "native"
            native.mkdir()
            check_native(native, args.offline)
    print("PASS: product strings, translated fingerprints, upstream credits, setup artwork, wide wordmarks, and repeatability.")


if __name__ == "__main__":
    main()
