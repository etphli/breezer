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
    for condition in ("!zen.enabled", "!vertical_right_aligned", "!is_fullscreen(",
                      "!delegate().IsVerticalTabStripCollapsed()",
                      "IsToolbarVisible()", "HostsBreezerWorkspace()"):
        require(condition in full_height, f"Full-height condition lost: {condition}")
    require(layout.index("const bool breezer_full_height_sidebar") <
            layout.index("if (breezer_full_height_sidebar) {\n        top_offset = 0;"),
            "Sidebar top is not raised to the window top")
    require("!breezer_full_height_sidebar\n            ? top_container_parent_params" in layout,
            "Top container is not laid out beside the full-height sidebar")
    require("SetBreezerTitlebarForLayout(" in layout and
            "breezer_full_height_sidebar ? vertical_tab_strip_animation.top_offset" in layout,
            "Title bar band does not follow the toolbar row")
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
