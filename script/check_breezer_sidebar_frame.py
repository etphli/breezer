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
    "views().vertical_tab_strip_region_view->IsBreezerAutoHideSidebar()": "auto_hide",
    "views().vertical_tab_strip_region_view->is_expanded_on_hover()": "hover_expanded",
    "layout_data_->vertical_tab_strip_animation.expand_on_hover_width >\n"
    "             0.0": "hover_visible",
    "IsParentedTo(views().top_container, views().browser_view)": "parented",
    "IsParentedTo(views().vertical_tab_strip_region_view,\n                   "
    "views().browser_view)": "parented",
    "views().vertical_tab_strip_region_view->HostsBreezerWorkspace()": "document",
}

# Normal window, sidebar shown and expanded, Breezer document loaded.
NORMAL = dict(vertical=True, zen=False, top_pinned=False, top_shown=True,
              sidebar_shown=True, right=False, rtl=False, fullscreen=False,
              toolbar=True, collapsed=False, parented=True, document=True,
              auto_hide=False, hover_expanded=False, hover_visible=False)
# The requested defaults: frameless on, always show top bar on, always show
# sidebar off (floating, here revealed), vertical tabs on the left. Pinning the
# sidebar changes only how it is placed, not whether it runs full height.
REQUESTED = dict(NORMAL, zen=True, top_pinned=True)
AUTO_HIDE = dict(NORMAL, collapsed=True, auto_hide=True, hover_expanded=True,
                 hover_visible=True)

FULL_HEIGHT_CASES = (
    ("normal window", NORMAL, True),
    ("requested frameless, floating sidebar revealed", REQUESTED, True),
    ("frameless, floating sidebar hidden", dict(REQUESTED, sidebar_shown=False), False),
    ("frameless, top bar auto-hides", dict(REQUESTED, top_pinned=False, top_shown=False), False),
    ("frameless, top bar sliding while pinning", dict(REQUESTED, top_shown=False), False),
    ("collapsed sidebar", dict(NORMAL, collapsed=True), False),
    ("frameless, collapsed sidebar", dict(REQUESTED, collapsed=True), False),
    ("autoHide sidebar revealed", AUTO_HIDE, True),
    ("autoHide reveal begins", dict(AUTO_HIDE, hover_visible=False), True),
    ("autoHide sidebar closing", dict(AUTO_HIDE, hover_expanded=False), True),
    ("autoHide sidebar hidden", dict(AUTO_HIDE, hover_expanded=False, hover_visible=False), False),
    ("frameless autoHide revealed", dict(AUTO_HIDE, zen=True, top_pinned=True), True),
    ("compact rail hover-expanded", dict(AUTO_HIDE, auto_hide=False), False),
    ("autoHide fullscreen", dict(AUTO_HIDE, fullscreen=True), False),
    ("autoHide right-aligned", dict(AUTO_HIDE, right=True), False),
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


def python_expression(expression):
    """Translates a C++ expression from the fixed layout vocabulary to Python."""
    python = re.sub(r"//[^\n]*", "", expression)
    python = python.replace("std::max(", "max(").replace("->", ".").replace("::", "_")
    python = python.replace("&&", " and ").replace("||", " or ")
    python = re.sub(r"!(?!=)", " not ", python)
    python = re.sub(r"(\d)\.0f\b", r"\1.0", python)
    ternary = re.fullmatch(r"\s*([^?]+?)\s*\?\s*([^:]+?)\s*:\s*([^:]+?)\s*", python, re.DOTALL)
    if ternary:
        python = f"({ternary[2]}) if ({ternary[1]}) else ({ternary[3]})"
    return " ".join(python.split())


def run_cpp_statements(source, names):
    """Runs straight-line C++ declarations, assignments and `if` blocks."""
    lines = []
    depth = 0
    source = re.sub(r"//[^\n]*", "", source)
    # Brace initializers become tuples, leaving braces only around blocks.
    source = re.sub(r"=\s*\{([^{}]*)\};", r"= (\1);", source)
    for statement in re.findall(r"[^;{}]*[;{}]", source):
        statement = statement.strip()
        if statement == "}":
            depth -= 1
            continue
        condition = re.fullmatch(r"if \((.*)\) \{", statement, re.DOTALL)
        if condition:
            lines.append("    " * depth + f"if {python_expression(condition[1])}:")
            depth += 1
            continue
        assignment = re.fullmatch(r"(?:const )?(?:int |float )?(\w+)\s*=\s*(.*);", statement, re.DOTALL)
        require(assignment is not None, f"Unmodelled layout statement: {statement!r}")
        value = assignment[2].strip()
        lines.append("    " * depth + f"{assignment[1]} = {python_expression(value)}")
    require(depth == 0, "Unbalanced layout statements")
    exec("\n".join(lines), {"__builtins__": {"max": max, "round": round}}, names)  # noqa: S102 - fixed vocabulary
    return names


def scale_extent(extent, ratio):
    return round(max(0, extent) * ratio)


class Rect:
    def __init__(self, x, y, width, height):
        self._bounds = (x, y, width, height)

    def x(self):
        return self._bounds[0]

    def y(self):
        return self._bounds[1]

    def height(self):
        return self._bounds[3]


class Namespace:
    def __init__(self, **values):
        self.__dict__.update(values)


# A 1200x800 client area with a 40 DIP toolbar row. Helium's floating sidebar
# is inset 8 DIP from the window edges and, below a pinned top bar, 5 DIP
# (frame radius 8 minus base padding 3) from whatever is above it.
TOOLBAR_ROW = 40
FLOATING_PADDING = 8
FLOATING_TOP_PADDING = 5


def sidebar_geometry(layout, full_height, floating):
    """The sidebar's bounds and title bar band as the patched layout computes them."""
    block = layout.split("      int top_offset = vertical_tab_strip_animation.top_offset;\n", 1)[1]
    block = "int top_offset = vertical_tab_strip_animation.top_offset;\n" + block.split(
        "vertical_tab_strip_width, vertical_tab_strip_height};\n", 1)[0] + \
        "vertical_tab_strip_width, vertical_tab_strip_height};\n"
    animation = Namespace(top_offset=TOOLBAR_ROW)
    zen = Namespace(enabled=True, top_chrome_ratio=1.0,
                    vertical_tab_strip_padding=FLOATING_PADDING if floating else 0,
                    vertical_tab_strip_top_padding=FLOATING_TOP_PADDING if floating else 0)
    names = run_cpp_statements(block, dict(
        vertical_tab_strip_animation=animation, zen=zen, ScaleExtent=scale_extent,
        breezer_full_height_sidebar=full_height,
        params=Namespace(visual_client_area=Rect(0, 0, 1200, 800)),
        vertical_tab_strip_x=zen.vertical_tab_strip_padding, vertical_tab_strip_width=260))
    band = layout.split("SetBreezerTitlebarForLayout(\n", 1)[1].split(",\n        base::ClampCeil(", 1)[0]
    band_height = eval(python_expression(band), {"__builtins__": {}}, dict(  # noqa: S307 - fixed vocabulary
        names, breezer_full_height_sidebar=full_height))
    return names["vertical_tab_strip_bounds"], band_height


def check_full_height_geometry(layout, region):
    """The shown full-height sidebar runs from the window top, under the controls."""
    for floating in (False, True):
        label = "floating (frameless)" if floating else "attached"
        (_, y, _, height), band = sidebar_geometry(layout, True, floating)
        require(y == 0, f"Full-height {label} sidebar starts {y} DIP below the window top")
        require(height == 800 - (FLOATING_PADDING if floating else 0),
                f"Full-height {label} sidebar has height {height}")
        require(y + band == TOOLBAR_ROW,
                f"Title bar band ends at {y + band}, not the toolbar row bottom {TOOLBAR_ROW}")
    # A floating sidebar that does not run full height keeps Helium's placement
    # below the top bar, and has no band.
    (_, y, _, height), band = sidebar_geometry(layout, False, True)
    require((y, height, band) == (TOOLBAR_ROW + FLOATING_TOP_PADDING,
                                  800 - TOOLBAR_ROW - FLOATING_TOP_PADDING - FLOATING_PADDING, 0),
            f"Floating sidebar below the top bar moved to y={y}, height={height}, band={band}")

    # The native background and the document must agree on a square top
    # wherever the region runs from the window top.
    shapes = (
        ("native background", region.split("void VerticalTabStripRegionView::SetFloatingStyleForLayout(", 1)[1]),
        ("sidebar document", region.split("gfx::RoundedCornersF BreezerWorkspaceCorners(", 1)[1]),
    )
    cases = (
        ("full-height floating sidebar", "kDetached", True, True, False),
        ("floating sidebar below the top bar", "kDetached", True, False, True),
        ("floating sidebar, top bar hidden", "kDetached", False, False, True),
        ("autoHide reveal beside the toolbar", "kAttachedLeading", True, True, False),
        ("compact rail hover below the toolbar", "kAttachedLeading", True, False, False),
    )
    for name, body in shapes:
        rule = re.search(r"const bool round_top =\s*(.*?);", body, re.DOTALL)
        require(rule is not None, f"{name} lost its rounded-top rule")
        python = python_expression(rule[1]).replace("FloatingStyle_", "")
        for label, style, below_toolbar, at_window_top, expected in cases:
            actual = eval(python, {"__builtins__": {}}, dict(  # noqa: S307 - fixed vocabulary
                style=style, kDetached="kDetached", below_toolbar=below_toolbar,
                at_window_top=at_window_top))
            require(actual == expected,
                    f"{name} for {label}: rounded top {actual}, expected {expected}")


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
    check_full_height_geometry(layout, region)
    require(layout.index("const bool breezer_full_height_sidebar") <
            layout.index("if (breezer_full_height_sidebar) {\n        top_offset = 0;"),
            "Sidebar top is not raised to the window top")
    require("!breezer_full_height_sidebar\n            ? top_container_parent_params\n"
            "            : breezer_beside_sidebar_params;" in layout,
            "Top container is not laid out beside the full-height sidebar")

    # Frameless with an unpinned sidebar: the sidebar floats over the page, so
    # the top bar is moved aside explicitly, in both top container passes.
    visible_edge = layout.split("        vertical_tab_strip_bounds = SlideBoundsFromSide(", 1)[1]
    visible_edge = visible_edge.split("      if (layout_data_->window_state", 1)[0]
    require("if (breezer_full_height_sidebar) {\n        breezer_sidebar_edge =\n"
            "            vertical_tab_strip_bounds.right()" in visible_edge,
            "Visible sidebar width does not move the top bar aside")
    require(visible_edge.index("\n      }\n") <
            visible_edge.index("if (breezer_full_height_sidebar)"),
            "Hover-expanded sidebar must move the toolbar even outside zen mode")
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
    # check_full_height_geometry covers the band's height.
    require(band.endswith("-\n            tabstrip_bounds->x())"),
            "Window controls width is not in the sidebar's coordinates")
    require(layout.count("/*at_window_top=*/breezer_full_height_sidebar);") == 1 and
            header.count("bool floating_at_window_top_ = false;") == 1,
            "The region is not told when it runs from the window top")
    for declaration in ("bool HostsBreezerWorkspace() const;",
                        "bool IsBreezerAutoHideSidebar() const;",
                        "void SetBreezerTitlebarForLayout(int height, int controls_width);"):
        require(header.count(declaration) == 1, f"Region header lacks {declaration}")
    auto_hide = region.split("bool VerticalTabStripRegionView::IsBreezerAutoHideSidebar() const {", 1)[1]
    require('breezer_workspace::prefs::kSidebarMode) == "autoHide"' in
            auto_hide.split("\n}", 1)[0],
            "AutoHide exception must not change compact-rail behavior")
    caption = region.split("bool VerticalTabStripRegionView::IsPositionInWindowCaption(", 1)[1]
    caption = caption.split("\n}\n", 1)[0]
    require(caption.index("IsHitInView(resize_area_, point)") < caption.index("IsPointInTitlebar("),
            "The resize edge must win over the title bar band")
    require('resize_area_->GetVisible() &&' in caption and
            'bottom_button_container_->GetVisible() &&' in caption,
            'Hidden native controls must not claim caption hits using stale bounds')
    require('workspace->IsDrawn() && IsHitInView(workspace, point)' in caption and
            'return workspace->IsPointInTitlebar(' in caption and
            caption.index('IsHitInView(workspace, point)') <
            caption.index('IsHitInView(bottom_button_container_, point)'),
            'Sidebar document body must be client input before native fallback tests')
    collapse_changed = region.split('void VerticalTabStripRegionView::OnCollapseStateChanged(', 1)[1]
    collapse_changed = collapse_changed.split('\n}', 1)[0]
    require('PostTask(' in collapse_changed and
            '&VerticalTabStripRegionView::UpdateExpandOnHoverState' in collapse_changed and
            'weak_factory_.GetWeakPtr(), std::nullopt' in collapse_changed and
            'base::WeakPtrFactory<VerticalTabStripRegionView> weak_factory_{this};' in header,
            'Hover motion must wait for the old animation completion callback to unwind')
    native_tests = (tree / sidebar_frame.REGION_TEST).read_text()
    require('BreezerFloatingCollapseKeepsHoverMotion' in native_tests and
            'BreezerHiddenControlsDoNotClaimCaption' in native_tests,
            'Native sidebar regressions are missing from browser_tests')
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
    downloads = parser.add_mutually_exclusive_group()
    downloads.add_argument("--offline", action="store_true",
                           help="Use only the prepared pinned-source cache")
    downloads.add_argument("--no-cache", action="store_true",
                           help="Fetch the pinned fixture into temporary storage only")
    args = parser.parse_args()
    use_merged_replacements()
    check_document()

    with tempfile.TemporaryDirectory(prefix="breezer-sidebar-frame-") as directory:
        if args.no_cache:
            source_fixture.CACHE = Path(directory).resolve() / "downloads"
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
