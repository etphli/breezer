#!/usr/bin/env python3
"""Exercise the full-height sidebar frame replacements on a pinned source fixture.

Merges breezer_sidebar_frame into the workspace overlay the way
apply_breezer_workspace.py does, then checks that the result applies,
re-applies idempotently, and composes with the assistant UI patch in either
order. Native compilation and real window behavior still need the browser build.
"""

import argparse
from pathlib import Path
import re
import shutil
import sys
import tempfile

import apply_breezer_ai_ui as ai_ui
import apply_breezer_workspace as workspace
import breezer_sidebar_frame as sidebar_frame
import check_ai_overlay as source_fixture

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "features/ai/extension"
VIEW = ROOT / "features/workspace/native/chrome/browser/ui/views/frame/breezer_workspace_view.cc"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def use_merged_replacements():
    """Merges like apply_breezer_workspace.py will, unless it already does."""
    base = workspace.replacements
    current = base()
    if all(pair in current.get(name, [])
           for name, pairs in sidebar_frame.replacements().items() for pair in pairs):
        return
    workspace.replacements = lambda: sidebar_frame.merge(base())


# Inputs to the full-height condition, as the requested settings produce them.
FULL_HEIGHT_INPUTS = {
    "layout_data_->tab_strip_type == TabStripType::kVertical": "vertical",
    "zen.enabled": "zen",
    "delegate().IsZenModeTopChromePinned()": "top_pinned",
    "zen.top_chrome_ratio >= 1.0f": "top_shown",
    "zen.ShouldLayoutVerticalTabStrip()": "sidebar_shown",
    "vertical_right_aligned": "right",
    "base::i18n::IsRTL()": "rtl",
    "is_fullscreen(layout_data_->window_state)": "fullscreen",
    "delegate().IsToolbarVisible()": "toolbar",
    "delegate().IsVerticalTabStripCollapsed()": "collapsed",
    "IsParentedTo(views().top_container, views().browser_view)": "parented",
    "IsParentedTo(views().vertical_tab_strip_region_view,\n                   "
    "views().browser_view)": "parented",
    "views().vertical_tab_strip_region_view->HostsBreezerWorkspace()": "document",
}

# Normal window, sidebar shown and expanded, Breezer document loaded.
NORMAL = dict(vertical=True, zen=False, top_pinned=False, top_shown=True,
              sidebar_shown=True, right=False, rtl=False, fullscreen=False,
              toolbar=True, collapsed=False, parented=True, document=True)
# The requested defaults: frameless on, always show top bar on, always show
# sidebar off (floating, here revealed), vertical tabs on the left. Pinning the
# sidebar changes only how it is placed, not whether it runs full height.
REQUESTED = dict(NORMAL, zen=True, top_pinned=True)

FULL_HEIGHT_CASES = (
    ("normal window", NORMAL, True),
    ("requested frameless, floating sidebar revealed", REQUESTED, True),
    ("frameless, floating sidebar hidden", dict(REQUESTED, sidebar_shown=False), False),
    ("frameless, top bar auto-hides", dict(REQUESTED, top_pinned=False, top_shown=False), False),
    ("frameless, top bar sliding while pinning", dict(REQUESTED, top_shown=False), False),
    ("collapsed sidebar", dict(NORMAL, collapsed=True), False),
    ("frameless, collapsed sidebar", dict(REQUESTED, collapsed=True), False),
    ("fullscreen", dict(NORMAL, fullscreen=True), False),
    ("frameless fullscreen", dict(REQUESTED, fullscreen=True), False),
    ("right-aligned sidebar", dict(NORMAL, right=True), False),
    ("right-to-left UI", dict(REQUESTED, rtl=True), False),
    ("toolbar hidden", dict(REQUESTED, toolbar=False), False),
    ("native tab strip fallback", dict(REQUESTED, document=False), False),
    ("horizontal tabs", dict(REQUESTED, vertical=False), False),
)


def check_full_height_cases(expression):
    """Evaluates the C++ full-height condition for the requested setting combinations."""
    python = expression
    for term, name in sorted(FULL_HEIGHT_INPUTS.items(), key=lambda item: -len(item[0])):
        require(term in python, f"Full-height condition lost: {term.split()[0]}")
        python = python.replace(term, f" {name} ")
    python = "(" + python.replace("&&", " and ").replace("||", " or ").replace("!", " not ") + ")"
    require(re.fullmatch(r"[\sa-z_()]+", python) is not None,
            f"Full-height condition has unmodelled terms: {python}")
    for label, inputs, expected in FULL_HEIGHT_CASES:
        actual = eval(python, {"__builtins__": {}}, dict(inputs))  # noqa: S307 - fixed vocabulary
        require(actual == expected,
                f"Full-height sidebar for {label}: expected {expected}, got {actual}")


def ai_layout_section():
    return ai_ui.sections()[sidebar_frame.LAYOUT]


def apply_ai_layout(tree, dry_run=False):
    result = ai_ui.patch(tree, ai_layout_section(), dry_run=dry_run)
    require(result.returncode == 0,
            f"Assistant UI layout patch no longer applies:\n{result.stdout}{result.stderr}")


def check_order(tree, ai_first):
    if ai_first:
        apply_ai_layout(tree)
    require(workspace.apply(tree) > 0, "Merged overlay changed nothing")
    require(workspace.apply(tree) == 0, "Merged overlay was not idempotent")
    workspace.apply(tree, check=True)
    if not ai_first:
        apply_ai_layout(tree, dry_run=True)

    layout = (tree / sidebar_frame.LAYOUT).read_text()
    region = (tree / sidebar_frame.REGION).read_text()
    header = (tree / sidebar_frame.REGION_HEADER).read_text()
    full_height = layout.split("const bool breezer_full_height_sidebar =", 1)[1].split(";", 1)[0]
    check_full_height_cases(full_height)
    require(layout.index("const bool breezer_full_height_sidebar") <
            layout.index("if (breezer_full_height_sidebar) {\n        top_offset = 0;"),
            "Sidebar top is not raised to the window top")
    require("!breezer_full_height_sidebar\n            ? top_container_parent_params\n"
            "            : breezer_beside_sidebar_params;" in layout,
            "Top container is not laid out beside the full-height sidebar")

    # Frameless with an unpinned sidebar: the sidebar floats over the page, so
    # the top bar is moved aside explicitly, in both top container passes.
    floating = layout.split("      if (zen.floating_vertical_tab_strip) {\n"
                            "        vertical_tab_strip_bounds = SlideBoundsFromSide(", 1)[1]
    floating = floating.split("\n      }\n", 1)[0]
    require("if (breezer_full_height_sidebar) {\n          breezer_sidebar_edge =\n"
            "              vertical_tab_strip_bounds.right()" in floating,
            "Floating sidebar does not move the top bar aside")
    require(layout.count("BesideBreezerSidebar(params, breezer_sidebar_edge)") == 2,
            "Both top container passes must sit beside a floating sidebar")
    require("BesideBreezerSidebar(params, breezer_sidebar_edge);\n"
            "    const gfx::Rect top_container_local_bounds = CalculateTopContainerLayout(\n"
            "        top_container_layout,\n        top_container_params.InLocalCoordinates(" in layout,
            "Assistant-panel top container pass ignores the floating sidebar")
    require("if (zen.floating_vertical_tab_strip && zen.TopChromeVisible() &&\n"
            "        !breezer_full_height_sidebar &&" in layout,
            "Floating full-height sidebar is still pushed below the top bar")
    band = layout.split("SetBreezerTitlebarForLayout(", 1)[1].split(";", 1)[0]
    require("breezer_full_height_sidebar\n            ? vertical_tab_strip_animation.top_offset -\n"
            "                  zen.vertical_tab_strip_top_padding\n            : 0" in band and
            band.endswith("-\n            tabstrip_bounds->x())"),
            "Title bar band is not the toolbar row in the sidebar's coordinates")
    for declaration in ("bool HostsBreezerWorkspace() const;",
                        "void SetBreezerTitlebarForLayout(int height, int controls_width);"):
        require(header.count(declaration) == 1, f"Region header lacks {declaration}")
    caption = region.split("bool VerticalTabStripRegionView::IsPositionInWindowCaption(", 1)[1]
    caption = caption.split("\n}\n", 1)[0]
    require(caption.index("IsHitInView(resize_area_, point)") < caption.index("IsPointInTitlebar("),
            "The resize edge must win over the title bar band")
    require("if (!HostsBreezerWorkspace()) {\n    available.Inset(interior_margin_);" in region,
            "Native margins still band the document")
    layout_body = region.split("void VerticalTabStripRegionView::Layout(PassKey) {", 1)[1].split("\n}\n", 1)[0]
    require("UpdateResizeAreaVisibility();" in layout_body,
            "Resize edge is not refreshed when the document becomes available")
    require("FloatingStyle::kDetached &&\n        HostsBreezerWorkspace()" in region,
            "Detached sidebar resize rule missing")


def check_document():
    view = VIEW.read_text()
    require("UpdateWindowControlsOverlay(area)" in view,
            "Native view does not report the title bar band to the document")
    create = view.split("void BreezerWorkspaceView::CreateExtensionContent()", 1)[1].split("\n}\n", 1)[0]
    require("UpdateTitlebarArea();" in create and "UpdateCornerRadii();" in create,
            "Recreated documents do not receive the band and corners")
    css = (EXTENSION / "workspace.css").read_text()
    require(re.search(r"env\(titlebar-area-height,\s*0px\)", css) is not None,
            "Sidebar does not reserve the title bar band")
    require("var(--sidebar-font-size" in css, "Sidebar text ignores --sidebar-font-size")
    script = (EXTENSION / "workspace.js").read_text()
    require("--sidebar-font-size" in script and "sidebarFontSize" in script,
            "Sidebar does not apply the sidebarFontSize appearance value")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true",
                        help="Use only the prepared pinned-source cache")
    args = parser.parse_args()
    use_merged_replacements()
    check_document()

    with tempfile.TemporaryDirectory(prefix="breezer-sidebar-frame-") as directory:
        base = Path(directory).resolve() / "pristine"
        originals = source_fixture.prepare(
            base, offline=args.offline, wanted_paths=tuple(workspace.replacements())
        )
        for ai_first in (False, True):
            tree = Path(directory).resolve() / ("ai-first" if ai_first else "workspace-first")
            shutil.copytree(base, tree)
            check_order(tree, ai_first)

    print(
        "PASS: full-height sidebar frame replacements merge into the workspace overlay, "
        f"apply to the pinned Chromium/Helium fixture ({len(originals)} upstream targets), "
        "re-apply idempotently, and compose with the assistant UI patch in either order."
    )
    print("Native compilation and real window behavior still require the full macOS browser build.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, AssertionError) as error:
        sys.exit(f"FAIL: {error}")
