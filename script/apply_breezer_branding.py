#!/usr/bin/env python3
"""Apply Breezer's identity to a prepared Chromium build tree."""

import argparse
import importlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps
from breezer_release import release_version


ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "upstream.lock.json").read_text())
CORE = ROOT / LOCK["helium"]["path"]
BUNDLE_ID = "io.github.etphli.breezer"

# Silhouette of the ribbon in breezer-logo.png, simplified for small UI icons.
BREEZER_MARK = (
    ("MOVE_TO", 9, 4),
    ("CUBIC_TO", 14, 4, 23, 7, 25, 13),
    ("CUBIC_TO", 26, 16, 25, 19, 25, 22),
    ("CUBIC_TO", 35, 17, 42, 21, 44, 29),
    ("CUBIC_TO", 47, 38, 40, 45, 30, 45),
    ("CUBIC_TO", 20, 45, 12, 41, 10, 33),
    ("CUBIC_TO", 8, 26, 13, 18, 12, 12),
    ("CUBIC_TO", 12, 9, 11, 6, 9, 4),
    ("CLOSE",),
    ("MOVE_TO", 25, 30),
    ("CUBIC_TO", 25, 35, 27, 39, 32, 39),
    ("CUBIC_TO", 36, 39, 39, 36, 38, 32),
    ("CUBIC_TO", 37, 28, 30, 26, 25, 30),
    ("CLOSE",),
)


def replace_file(path, replacements):
    text = path.read_text()
    for before, after in replacements.items():
        if before not in text and after not in text:
            raise ValueError(f"Branding input changed in {path}: {before!r}")
        text = text.replace(before, after)
    path.write_text(text)


def brand_internal_urls(tree):
    # Chromium still navigates to chrome://. Both product schemes are aliases
    # so old bookmarks and copied addresses keep working.
    replace_file(tree / "content/public/common/url_constants.h", {
        'inline constexpr char kHeliumUIScheme[] = "helium";  // also used for webuis :3':
            'inline constexpr char kBreezerUIScheme[] = "breezer";\n'
            'inline constexpr char kLegacyHeliumUIScheme[] = "helium";',
    })
    replace_file(tree / "content/common/url_schemes.cc", {
        "  kHeliumUIScheme,": "  kBreezerUIScheme,\n  kLegacyHeliumUIScheme,",
        "url::AddStandardScheme(kHeliumUIScheme, url::SCHEME_WITH_HOST);":
            "url::AddStandardScheme(kBreezerUIScheme, url::SCHEME_WITH_HOST);\n"
            "  url::AddStandardScheme(kLegacyHeliumUIScheme, url::SCHEME_WITH_HOST);",
        **{
            f"{kind}.push_back(kHeliumUIScheme);":
                f"{kind}.push_back(kBreezerUIScheme);\n"
                f"  {kind}.push_back(kLegacyHeliumUIScheme);"
            for kind in ("schemes.secure_schemes", "schemes.cors_enabled_schemes",
                         "schemes.service_worker_schemes")
        },
    })
    replace_file(tree / "content/renderer/render_thread_impl.cc", {
        """  // helium:
  WebString helium_scheme(WebString::FromAscii(kHeliumUIScheme));
  WebSecurityPolicy::RegisterURLSchemeAsDisplayIsolated(helium_scheme);
  WebSecurityPolicy::RegisterURLSchemeAsNotAllowingJavascriptURLs(
      helium_scheme);
  WebSecurityPolicy::RegisterURLSchemeAsWebUI(helium_scheme);""":
        """  for (const char* alias : {kBreezerUIScheme, kLegacyHeliumUIScheme}) {
    WebString webui_scheme(WebString::FromAscii(alias));
    WebSecurityPolicy::RegisterURLSchemeAsDisplayIsolated(webui_scheme);
    WebSecurityPolicy::RegisterURLSchemeAsNotAllowingJavascriptURLs(webui_scheme);
    WebSecurityPolicy::RegisterURLSchemeAsWebUI(webui_scheme);
  }""",
    })
    for path, before, after in (
        ("chrome/browser/profiles/profile_io_data.cc", "content::kHeliumUIScheme,",
         "content::kBreezerUIScheme,\n      content::kLegacyHeliumUIScheme,"),
        ("chrome/browser/history/history_utils.cc", "url.SchemeIs(content::kHeliumUIScheme) ||",
         "url.SchemeIs(content::kBreezerUIScheme) ||\n      url.SchemeIs(content::kLegacyHeliumUIScheme) ||"),
        ("chrome/browser/ui/incognito_allowed_url.cc", "scheme != content::kHeliumUIScheme)",
         "scheme != content::kBreezerUIScheme &&\n      scheme != content::kLegacyHeliumUIScheme)"),
        ("chrome/browser/ui/navigator/browser_navigator.cc", "params->url.scheme() == content::kHeliumUIScheme)",
         "params->url.SchemeIs(content::kBreezerUIScheme) ||\n      params->url.SchemeIs(content::kLegacyHeliumUIScheme))"),
        ("chrome/browser/extensions/extension_tab_util.cc", "&& !url.SchemeIs(content::kHeliumUIScheme))",
         "&& !url.SchemeIs(content::kBreezerUIScheme) &&\n      !url.SchemeIs(content::kLegacyHeliumUIScheme))"),
    ):
        replace_file(tree / path, {before: after})

    for path, before, condition, indentation in (
        ("chrome/browser/ui/browser_web_contents_delegate/browser_web_contents_delegate.cc",
         "patched_url.SchemeIs(content::kChromeUIScheme)", "patched_url.SchemeIs", "      "),
        ("components/omnibox/browser/omnibox_text_util.cc",
         "url_from_text->scheme() == content::kChromeUIScheme", "url_from_text->SchemeIs", "        "),
        ("components/url_formatter/url_formatter.cc",
         "url.SchemeIs(content::kChromeUIScheme)", "url.SchemeIs", "        "),
    ):
        replace_file(tree / path, {
            f"if ({before}) {{\n": f"if ({condition}(content::kChromeUIScheme) ||\n"
                                   f"{indentation}{condition}(content::kLegacyHeliumUIScheme)) {{\n",
            "replacements.SetSchemeStr(content::kHeliumUIScheme);":
                "replacements.SetSchemeStr(content::kBreezerUIScheme);",
        })

    replace_file(tree / "components/url_formatter/url_fixer.cc", {
        'const char kHeliumUIScheme[] = "helium";':
            'const char kBreezerUIScheme[] = "breezer";\n'
            'const char kLegacyHeliumUIScheme[] = "helium";',
        'const size_t kMaxFixupURLDepth = 16;\n\n// TODO(estade)':
            'const size_t kMaxFixupURLDepth = 16;\n\n'
            'bool IsInternalUIScheme(std::string_view scheme) {\n'
            '  return scheme == kChromeUIScheme || scheme == url::kAboutScheme ||\n'
            '         scheme == kBreezerUIScheme || scheme == kLegacyHeliumUIScheme;\n'
            '}\n\n// TODO(estade)',
        """(url::IsStandard(scheme) || scheme == url::kAboutScheme ||
           scheme == kChromeUIScheme || scheme == kHeliumUIScheme ||""":
            "(url::IsStandard(scheme) || IsInternalUIScheme(scheme) ||",
        """if ((scheme != url::kAboutScheme) && (scheme != kChromeUIScheme) &&
      (scheme != kHeliumUIScheme) && (scheme != kDevToolsScheme) &&""":
            "if (!IsInternalUIScheme(scheme) && scheme != kDevToolsScheme &&",
        """bool chrome_url =
      (scheme == url::kAboutScheme)
      || (scheme == kChromeUIScheme)
      || (scheme == kHeliumUIScheme);""":
            "bool chrome_url = IsInternalUIScheme(scheme);",
        """  return scheme1 == scheme2 ||
         (scheme1 == url::kAboutScheme && scheme2 == kChromeUIScheme) ||
         (scheme1 == kChromeUIScheme && scheme2 == url::kAboutScheme) ||
         (scheme1 == kHeliumUIScheme && scheme2 == url::kAboutScheme) ||
         (scheme1 == url::kAboutScheme && scheme2 == kHeliumUIScheme) ||
         (scheme1 == kHeliumUIScheme && scheme2 == kChromeUIScheme)   ||
         (scheme1 == kChromeUIScheme && scheme2 == kHeliumUIScheme);""":
            "  return scheme1 == scheme2 ||\n"
            "         (IsInternalUIScheme(scheme1) && IsInternalUIScheme(scheme2));",
    })
    replace_file(tree / "chrome/browser/autocomplete/chrome_autocomplete_provider_client.cc", {
        "return content::kHeliumUIScheme;": "return content::kBreezerUIScheme;",
        "  builtins_to_provide.push_back(chrome::kChromeUIVersionURL16);\n"
        "  return builtins_to_provide;":
            "  builtins_to_provide.push_back(chrome::kChromeUIVersionURL16);\n"
            "  for (auto& builtin_url : builtins_to_provide) {\n"
            "    GURL url(builtin_url);\n"
            "    GURL::Replacements replacements;\n"
            "    replacements.SetSchemeStr(content::kBreezerUIScheme);\n"
            "    builtin_url =\n"
            "        base::ASCIIToUTF16(url.ReplaceComponents(replacements).spec());\n"
            "  }\n"
            "  return builtins_to_provide;",
    })
    replace_file(tree / "components/omnibox/browser/builtin_provider.cc", {
        """      DCHECK(url.starts_with(u"chrome://"));
      AddBuiltinMatch(std::u16string(url).replace(0, 6, u"helium"),
                      std::u16string(), styles);""":
            "      AddBuiltinMatch(url, std::u16string(), styles);",
        """  const std::u16string embedderAbout = base::StrCat(
      {base::UTF8ToUTF16(client_->GetEmbedderRepresentationOfAboutScheme()),
       url::kStandardSchemeSeparator16});""":
            """  const std::string embedder_scheme =
      client_->GetEmbedderRepresentationOfAboutScheme();
  const std::u16string embedderAbout = base::StrCat(
      {base::UTF8ToUTF16(embedder_scheme), url::kStandardSchemeSeparator16});""",
        "    if (url.SchemeIs(client_->GetEmbedderRepresentationOfAboutScheme()) &&":
            "    if (url_formatter::IsEquivalentScheme(url.GetScheme(), embedder_scheme) &&",
        "          TermMatches style_matches = {{0, 0, match_length}};":
            """          const bool matching_scheme = url.SchemeIs(embedder_scheme);
          const size_t match_start = matching_scheme ? 0 : embedderAbout.length();
          TermMatches style_matches = {{0, match_start, match_length - match_start}};""",
        """          if (text_ends_with_slash &&
              !base::StartsWith(match_string.substr(match_length), u"/",
                                base::CompareCase::INSENSITIVE_ASCII))""":
            """          if (!matching_scheme ||
              (text_ends_with_slash &&
               !base::StartsWith(inline_autocompletion, u"/",
                                 base::CompareCase::INSENSITIVE_ASCII)))""",
    })
    replace_file(tree / "chrome/browser/resources/tab_search/tab_search_item.ts", {
        """    // Show chrome:// if it's a chrome internal url
    const protocol = new URL(normalizeURL(data.tab.url)).protocol;
    if (protocol === 'chrome:' || protocol === 'helium:') {
      this.$.secondaryTextInner.prepend(document.createTextNode('helium://'));""":
            """    // Use Breezer's display scheme for internal pages.
    const protocol = new URL(normalizeURL(data.tab.url)).protocol;
    if (['chrome:', 'breezer:', 'helium:'].includes(protocol)) {
      this.$.secondaryTextInner.prepend(document.createTextNode('breezer://'));""",
    })


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


def brand_version(tree):
    version = release_version(ROOT)
    replace_file(tree / 'base/version_info/version_info_values.h.version', {
        '#define HELIUM_PRODUCT_VERSION "@HELIUM_MAJOR@.@HELIUM_MINOR@.@HELIUM_PATCH@.@HELIUM_PLATFORM@"':
            f'#define HELIUM_PRODUCT_VERSION "{version}"',
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
            (re.compile(r"\bHelium\b(?!\s+(?:servers|Authors|[Pp]artners?)\b)"), "Breezer"),
        ]
        utility.replace_grit_message = replace_message
        utility.replace_xtb_translation = replace_translation
        utility.add_grit_to_path(tree)
        results = []
        for path in substitution.get_substitutable_files(tree, ["grd", "grdp"]):
            fragment_without_declaration = path.suffix == ".grdp" and not path.read_text().lstrip().startswith("<?xml")
            result = substitution.substitute_grit_file((path, tree, False, False))
            if result is not None:
                if fragment_without_declaration:
                    path.write_text(re.sub(r"^<\?xml[^>]*\?>\s*", "", path.read_text(), count=1))
                results.append(result)
        fingerprints = utility.merge_fp_maps(results)
        for path in substitution.get_substitutable_files(tree, ["xtb"]):
            substitution.substitute_xtb_file((path, tree, fingerprints, False, False))
    finally:
        utility.REPLACEMENT_REGEXES = original_regexes
        utility.replace_grit_message = original_message
        utility.replace_xtb_translation = original_translation


def brand_native_labels(tree):
    replace_file(tree / "components/extstore_fixups/chrome-webstore.js", {
        "replace(CHROME_NAME_REGEX, 'Helium')": "replace(CHROME_NAME_REGEX, 'Breezer')",
    })
    replace_file(tree / "components/helium_services/schema.cc", {
        "major changes to Helium services": "major changes to Breezer services",
    })
    replace_file(tree / "chrome/browser/helium_flag_entries.h", {
        '"Helium Noise"': '"Breezer Noise"',
        "Helium's anti-fingerprinting": "Breezer's anti-fingerprinting",
        "Helium flag": "Breezer flag",
        "Helium \"\n     \"flag.": "Breezer \"\n     \"flag.",
        "whether Helium asks": "whether Breezer asks",
        "[Helium Noise]": "[Breezer Noise]",
    })


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
    replace_file(onboarding / "src/pages/HeliumServices.svelte", {
        'import { CardLink, HeliumLogo } from "@imput/helium-prism";':
            'import { CardLink } from "@imput/helium-prism";\n'
            '    import BreezerLogo from "../components/BreezerLogo.svelte";',
        "Icon={HeliumLogo}": "Icon={BreezerLogo}",
    })
    replace_file(onboarding / "src/components/HeliumPartner.svelte", {
        'import { HeliumLogo, Tooltip }': 'import { IconInfo, Tooltip }',
        '<HeliumLogo height="13px" />': '<IconInfo />',
        "    .helium-partner-badge {\n        display: flex;":
            "    .helium-partner-badge {\n"
            "        & :global(svg) {\n"
            "            width: 13px;\n"
            "            height: 13px;\n"
            "        }\n\n"
            "        display: flex;",
    })
    (onboarding / "src/components/BreezerLogo.svelte").write_text('''<script lang="ts">
    const { height = "32px" }: { height?: string } = $props();
</script>

<img src="/breezer-logo.png" alt="" style:width={height} style:height={height} />
''')
    logo = ROOT / "assets/branding/breezer-logo.png"
    shutil.copyfile(logo, onboarding / "public/breezer-logo.png")
    with Image.open(logo) as source:
        source.resize((32, 32), Image.Resampling.LANCZOS).save(onboarding / "public/favicon.png")


def scale(logo, size, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["sips", "-z", str(size), str(size), str(logo), "--out", str(target)],
        check=True, stdout=subprocess.DEVNULL,
    )


def brand_resource_png(logo, target):
    with Image.open(target) as original:
        width, height = original.size
    with Image.open(logo) as source:
        icon = ImageOps.contain(source.convert("RGBA"), (height, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (width, height))
    if width == height:
        canvas.alpha_composite(icon, ((width - icon.width) // 2, (height - icon.height) // 2))
    else:
        # These inherited slots contain a wide product wordmark, not an app icon.
        font = ImageFont.load_default(size=max(10, round(height * 0.62)))
        draw = ImageDraw.Draw(canvas)
        bounds = draw.textbbox((0, 0), "Breezer", font=font)
        text_width, text_height = bounds[2] - bounds[0], bounds[3] - bounds[1]
        gap = max(3, height // 5)
        left = max(0, (width - icon.width - gap - text_width) // 2)
        canvas.alpha_composite(icon, (left, (height - icon.height) // 2))
        color = "white" if "white" in target.name else "#182c31"
        draw.text((left + icon.width + gap, (height - text_height) // 2 - bounds[1]), "Breezer", font=font, fill=color)
    canvas.save(target)


def brand_vector_icons(tree):
    # Give the existing address-bar star its own role so swapping product
    # logos elsewhere cannot change the internal-page indicator.
    icon_dir = tree / "components/omnibox/browser/vector_icons"
    star = CORE / "resources/branding/product_logo.icon"
    shutil.copyfile(star, icon_dir / "internal_page.icon")
    replace_file(tree / "components/omnibox/browser/BUILD.gn", {
        '    "install_desktop_old.icon",\n    "journeys_chrome_refresh_old.icon",':
            '    "install_desktop_old.icon",\n    "internal_page.icon",\n'
            '    "journeys_chrome_refresh_old.icon",',
    })
    replace_file(tree / "chrome/browser/ui/toolbar/chrome_location_bar_model_delegate.cc", {
        """    return &(features::IsRoundedIconsEnabled()
                 ? omnibox::kChromeProductIcon
                 : omnibox::kProductChromeRefreshOldIcon);""":
            "    return &omnibox::kInternalPageIcon;",
    })

    native_mark = "\n".join(", ".join(map(str, command)) + "," for command in BREEZER_MARK)
    mono = f"CANVAS_DIMENSIONS, 48,\n{native_mark.removesuffix(',')}\n"
    color = (
        "CANVAS_DIMENSIONS, 48,\n"
        "PATH_COLOR_ARGB, 0xFF, 0x08, 0x2E, 0x3D,\n"
        "ROUND_RECT, 0, 0, 48, 48, 12,\n"
        "NEW_PATH,\n"
        "PATH_COLOR_ARGB, 0xFF, 0x7A, 0xF4, 0xDB,\n"
        f"{native_mark.removesuffix(',')}\n"
    )
    verbs = {"MOVE_TO": "M", "CUBIC_TO": "C", "CLOSE": "Z"}
    path = " ".join(" ".join([verbs[verb], *map(str, points)]) for verb, *points in BREEZER_MARK)
    svg = (
        '<svg width="256" height="256" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">\n'
        '  <rect width="48" height="48" rx="12" fill="#082e3d"/>\n'
        f'  <path fill="#7af4db" fill-rule="evenodd" d="{path}"/>\n'
        '</svg>\n'
    )
    resources = {"product_logo.icon": mono, "product_logo_color.icon": color, "product_logo.svg": svg}
    for source, target in branding_resources():
        if artifact := resources.get(Path(source).name):
            file = tree / target
            if file.read_text() not in ((CORE / "resources" / source).read_text(), artifact):
                raise ValueError(f"Branding asset changed in {target}")
            file.write_text(artifact)

    icons_file = tree / "ui/webui/resources/cr_elements/icons.html.ts"
    # Replace both rounded and legacy WebUI product icon definitions.
    original_viewbox = '<g id="chrome-product" viewBox="0 0 56 56">'
    branded_group = (f'<g id="chrome-product" viewBox="0 0 48 48">\n'
                     f'        <path fill-rule="evenodd" d="{path}"/>\n'
                     '      </g>')
    text = icons_file.read_text()
    text = re.sub(re.escape(original_viewbox) + r".*?</g>", branded_group, text, flags=re.DOTALL)
    if text.count('<g id="chrome-product"') != 2 or text.count(branded_group) != 2:
        raise ValueError(f"Branding input changed in {icons_file}")
    icons_file.write_text(text)


def branding_resources():
    for line in (CORE / "resources/helium_resources.txt").read_text().splitlines():
        if line.startswith(("branding/product_logo", "generated/product_icon/")):
            yield line.split()


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

    for source, target in branding_resources():
        if not source.endswith(".png"):
            continue
        target = tree / target
        header = target.read_bytes()[:24]
        if header[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"Expected a PNG branding target: {target}")
        brand_resource_png(logo, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_tree", type=Path)
    args = parser.parse_args()
    tree = args.source_tree.resolve()
    if not (tree / "OWNERS").is_file() or not (tree / "tools/grit").is_dir():
        parser.error("Use the prepared Chromium source tree, after applying upstream patches.")
    brand_version(tree)
    brand_product(tree)
    brand_internal_urls(tree)
    brand_strings(tree)
    brand_native_labels(tree)
    brand_onboarding(tree)
    brand_vector_icons(tree)
    brand_icons(tree)
    print("Breezer product identity, profile directory, Keychain names, UI strings, and app icons prepared.")


if __name__ == "__main__":
    main()
