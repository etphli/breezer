#!/usr/bin/env python3
"""Check Breezer branding against the pinned Chromium GRIT implementation."""

import argparse
import importlib
from pathlib import Path
import sys
import tempfile
import xml.etree.ElementTree as xml

import apply_breezer_branding as branding


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("grit_directory", type=Path)
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
        messages = xml.parse(tree / "messages.grdp").getroot()
        translated = xml.parse(tree / "messages.xtb").getroot()
        assert messages[0].text == "Meet Breezer"
        assert messages[1].text == "This supports the development of Helium.", "Upstream funding credit was rebranded."
        assert messages[2].text == "Helium services"
        assert translated[0].text == "Hallo Breezer"
        assert translated[0].get("id") == str(utility.compute_fp(messages[0]))
        assert translated[1].text == texts[1], "Translated funding credit was rebranded."
        assert translated[1].get("id") == ids[1]

        before = {name: (tree / name).read_bytes() for name in ("messages.grdp", "messages.xtb")}
        branding.brand_strings(tree)
        assert before == {name: (tree / name).read_bytes() for name in before}, "Branding is not repeatable."

        onboarding = tree / "components/helium_onboarding"
        (onboarding / "public").mkdir(parents=True)
        (onboarding / "src/pages").mkdir(parents=True)
        (onboarding / "index.html").write_text("<title>Helium Setup</title>")
        for page in ("Welcome.svelte", "Finish.svelte"):
            (onboarding / "src/pages" / page).write_text(
                '    HeliumLogo,\n<HeliumLogo height="64px" />\n'
            )
        branding.brand_onboarding(tree)
        branding.brand_onboarding(tree)
        assert "Breezer Setup" in (onboarding / "index.html").read_text()
        for page in ("Welcome.svelte", "Finish.svelte"):
            body = (onboarding / "src/pages" / page).read_text()
            assert 'alt="Breezer"' in body and "HeliumLogo" not in body
        assert (onboarding / "public/breezer-logo.png").read_bytes() == (
            branding.ROOT / "assets/branding/breezer-logo.png"
        ).read_bytes()
    print("PASS: product strings, translated fingerprints, service credits, setup artwork, and repeatability.")


if __name__ == "__main__":
    main()
