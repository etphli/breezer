#!/usr/bin/env python3
"""Native replacements for Breezer's full-height sidebar frame.

Imported by apply_breezer_workspace.py, which merges these replacements after
its own and validates them the same way. The region view anchors below match
the vertical tab strip region after the workspace replacements have run.

- An expanded, left-aligned sidebar that shows the Breezer document runs the
  full window height. The toolbar and bookmarks bar sit beside it and the
  window controls are drawn over the document's top band. That band drags the
  window and is reported to the document as CSS titlebar-area-* variables.
- Zen mode (frameless) does the same while its top bar is pinned. A pinned
  sidebar sits beside the toolbar as in a normal window. An unpinned
  (floating) sidebar still overlays the page while it is revealed, but the top
  bar moves aside with it, so the back, forward, and address controls stay
  usable beside it.
- The document fills the region edge to edge, so no frame-colored bands show
  above or below it, and it takes the region's rounded floating shape.
- The detached (zen mode) sidebar keeps its native resize edge, placed at the
  region's own right edge rather than in its parent's coordinates.

Zen mode with an auto-hiding top bar, a hidden floating sidebar, fullscreen,
a collapsed rail, a hidden autoHide sidebar, a right-aligned sidebar, and
windows that show Chromium's own tab rows keep the upstream layout.
"""

REGION = "chrome/browser/ui/views/frame/vertical_tab_strip_region_view.cc"
REGION_HEADER = "chrome/browser/ui/views/frame/vertical_tab_strip_region_view.h"
LAYOUT = "chrome/browser/ui/views/frame/layout/browser_view_tabbed_layout_impl.cc"


def _region_header_replacements():
    return [
        (
            "  void SetFloatingStyleForLayout(FloatingStyle style,\n"
            "                                 int corner_radius,\n"
            "                                 bool below_toolbar);\n",
            "  void SetFloatingStyleForLayout(FloatingStyle style,\n"
            "                                 int corner_radius,\n"
            "                                 bool below_toolbar);\n"
            "\n"
            "  // Breezer: whether this region shows the Breezer sidebar document.\n"
            "  bool HostsBreezerWorkspace() const;\n"
            "  bool IsBreezerAutoHideSidebar() const;\n"
            "  // Breezer: the window title bar band drawn over the top of the\n"
            "  // document, with the window controls covering `controls_width` at the\n"
            "  // leading edge. Zero height when the region starts below the toolbar.\n"
            "  void SetBreezerTitlebarForLayout(int height, int controls_width);\n",
        ),
    ]


def _region_replacements():
    return [
        (
            "      region->GetViewByID(BreezerWorkspaceView::kViewId));\n"
            "}\n"
            "#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n",
            "      region->GetViewByID(BreezerWorkspaceView::kViewId));\n"
            "}\n"
            "#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n"
            "\n"
            "#if BUILDFLAG(ENABLE_EXTENSIONS)\n"
            "// The document fills the region, so it takes the region's floating shape:\n"
            "// rounded except along an attached window edge, and square at the top\n"
            "// where it joins the toolbar.\n"
            "gfx::RoundedCornersF BreezerWorkspaceCorners(\n"
            "    VerticalTabStripRegionView::FloatingStyle style,\n"
            "    int corner_radius,\n"
            "    bool below_toolbar) {\n"
            "  using FloatingStyle = VerticalTabStripRegionView::FloatingStyle;\n"
            "  if (style == FloatingStyle::kNone) {\n"
            "    return gfx::RoundedCornersF();\n"
            "  }\n"
            "  const bool rtl = base::i18n::IsRTL();\n"
            "  const bool round_top = style == FloatingStyle::kDetached || !below_toolbar;\n"
            "  const bool round_left =\n"
            "      style != (rtl ? FloatingStyle::kAttachedTrailing\n"
            "                    : FloatingStyle::kAttachedLeading);\n"
            "  const bool round_right =\n"
            "      style != (rtl ? FloatingStyle::kAttachedLeading\n"
            "                    : FloatingStyle::kAttachedTrailing);\n"
            "  const float radius = corner_radius;\n"
            "  return gfx::RoundedCornersF(round_top && round_left ? radius : 0,\n"
            "                              round_top && round_right ? radius : 0,\n"
            "                              round_right ? radius : 0,\n"
            "                              round_left ? radius : 0);\n"
            "}\n"
            "#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n",
        ),
        # The band under the window controls drags the window. On macOS this
        # also routes the click past the document's native view.
        (
            "  if (IsHitInView(resize_area_, point)) {\n"
            "    return false;\n"
            "  }\n",
            "  if (IsHitInView(resize_area_, point)) {\n"
            "    return false;\n"
            "  }\n"
            "\n"
            "#if BUILDFLAG(ENABLE_EXTENSIONS)\n"
            "  // The window controls are drawn over the top of Breezer's document; that\n"
            "  // band drags the window like the rest of the title bar.\n"
            "  if (BreezerWorkspaceView* const workspace = FindBreezerWorkspace(this);\n"
            "      workspace && workspace->GetVisible() &&\n"
            "      workspace->IsPointInTitlebar(\n"
            "          views::View::ConvertPointToTarget(this, workspace, point))) {\n"
            "    return true;\n"
            "  }\n"
            "#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n",
        ),
        (
            "void VerticalTabStripRegionView::AddedToWidget() {\n",
            "bool VerticalTabStripRegionView::HostsBreezerWorkspace() const {\n"
            "#if BUILDFLAG(ENABLE_EXTENSIONS)\n"
            "  const auto* const workspace = views::AsViewClass<BreezerWorkspaceView>(\n"
            "      GetViewByID(BreezerWorkspaceView::kViewId));\n"
            "  return workspace && workspace->is_available();\n"
            "#else\n"
            "  return false;\n"
            "#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n"
            "}\n"
            "\n"
            "bool VerticalTabStripRegionView::IsBreezerAutoHideSidebar() const {\n"
            "  return browser_view()->browser()->GetProfile()->GetPrefs()->GetString(\n"
            "             breezer_workspace::prefs::kSidebarMode) == \"autoHide\";\n"
            "}\n"
            "\n"
            "void VerticalTabStripRegionView::SetBreezerTitlebarForLayout(\n"
            "    int height,\n"
            "    int controls_width) {\n"
            "#if BUILDFLAG(ENABLE_EXTENSIONS)\n"
            "  if (BreezerWorkspaceView* const workspace = FindBreezerWorkspace(this)) {\n"
            "    workspace->SetTitlebar(height, controls_width);\n"
            "  }\n"
            "#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n"
            "}\n"
            "\n"
            "void VerticalTabStripRegionView::AddedToWidget() {\n",
        ),
        # Breezer's document spaces its own content; the native margins would
        # show as frame-colored bands above and below it.
        (
            "  available.Inset(interior_margin_);\n",
            "  if (!HostsBreezerWorkspace()) {\n"
            "    available.Inset(interior_margin_);\n"
            "  }\n",
        ),
        (
            "  shadow_frame_->SetBoundsRect(GetLocalBounds());\n",
            "  shadow_frame_->SetBoundsRect(GetLocalBounds());\n"
            "#if BUILDFLAG(ENABLE_EXTENSIONS)\n"
            "  // Also runs after the document is (re)created or becomes available,\n"
            "  // which a style change alone would miss. Both calls are no-ops unless\n"
            "  // something changed.\n"
            "  UpdateResizeAreaVisibility();\n"
            "  // The edge is placed in local coordinates; the region is inset from the\n"
            "  // window edge when it floats (zen mode).\n"
            "  if (!state_controller_->IsTabStripRightAligned()) {\n"
            "    resize_area_->SetX(width() - resize_area_width_);\n"
            "  }\n"
            "  if (BreezerWorkspaceView* const workspace = FindBreezerWorkspace(this)) {\n"
            "    workspace->SetCornerRadii(BreezerWorkspaceCorners(\n"
            "        floating_style_, floating_corner_radius_, floating_below_toolbar_));\n"
            "  }\n"
            "#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n",
        ),
        (
            "void VerticalTabStripRegionView::UpdateResizeAreaVisibility() {\n"
            "  if (floating_style_ != FloatingStyle::kNone) {\n",
            "void VerticalTabStripRegionView::UpdateResizeAreaVisibility() {\n"
            "  // Breezer's detached (zen mode) sidebar keeps its resize edge.\n"
            "  if (floating_style_ != FloatingStyle::kNone &&\n"
            "      !(floating_style_ == FloatingStyle::kDetached &&\n"
            "        HostsBreezerWorkspace())) {\n",
        ),
    ]


def _layout_replacements():
    return [
        (
            "void InsetHorizontal(gfx::Rect& rect, int amount, bool leading) {\n"
            "  rect.Inset(\n"
            "      gfx::Insets::TLBR(0, leading ? amount : 0, 0, !leading ? amount : 0));\n"
            "}\n",
            "void InsetHorizontal(gfx::Rect& rect, int amount, bool leading) {\n"
            "  rect.Inset(\n"
            "      gfx::Insets::TLBR(0, leading ? amount : 0, 0, !leading ? amount : 0));\n"
            "}\n"
            "\n"
            "// Breezer: `params` narrowed to start at `leading_edge`. Unchanged when the\n"
            "// edge is at or before the client area's leading edge.\n"
            "BrowserLayoutParams BesideBreezerSidebar(BrowserLayoutParams params,\n"
            "                                         int leading_edge) {\n"
            "  params.InsetHorizontal(\n"
            "      std::max(0, leading_edge - params.visual_client_area.x()),\n"
            "      /*leading=*/true);\n"
            "  return params;\n"
            "}\n",
        ),
        (
            "  const bool vertical_right_aligned =\n"
            "      delegate().IsVerticalTabStripRightAligned();\n"
            "\n"
            "  if (IsParentedTo(views().organizer_tray, views().browser_view)) {\n",
            "  const bool vertical_right_aligned =\n"
            "      delegate().IsVerticalTabStripRightAligned();\n"
            "  // Breezer: the sidebar document runs the full window height. The window\n"
            "  // controls are drawn over its top and the toolbar sits beside it. In zen\n"
            "  // mode this needs a pinned top bar and a shown sidebar. An auto-hiding\n"
            "  // top bar, fullscreen, a collapsed rail or right-aligned sidebar, and\n"
            "  // Chromium's own tab rows keep the upstream layout.\n"
            "  // Hover expansion leaves the controller collapsed. Keep autoHide\n"
            "  // full height through its reveal and closing animation.\n"
            "  const bool breezer_full_height_sidebar =\n"
            "      layout_data_->tab_strip_type == TabStripType::kVertical &&\n"
            "      (!zen.enabled || (delegate().IsZenModeTopChromePinned() &&\n"
            "                        zen.top_chrome_ratio >= 1.0f)) &&\n"
            "      zen.ShouldLayoutVerticalTabStrip() && !vertical_right_aligned &&\n"
            "      !base::i18n::IsRTL() && !is_fullscreen(layout_data_->window_state) &&\n"
            "      delegate().IsToolbarVisible() &&\n"
            "      IsParentedTo(views().top_container, views().browser_view) &&\n"
            "      IsParentedTo(views().vertical_tab_strip_region_view,\n"
            "                   views().browser_view) &&\n"
            "      (!delegate().IsVerticalTabStripCollapsed() ||\n"
            "       (views().vertical_tab_strip_region_view->IsBreezerAutoHideSidebar() &&\n"
            "        (views().vertical_tab_strip_region_view->is_expanded_on_hover() ||\n"
            "         layout_data_->vertical_tab_strip_animation.expand_on_hover_width >\n"
            "             0.0))) &&\n"
            "      views().vertical_tab_strip_region_view->HostsBreezerWorkspace();\n"
            "  // Where the top bar starts beside a full-height sidebar, including\n"
            "  // hover expansion over the page and a floating zen sidebar.\n"
            "  int breezer_sidebar_edge = 0;\n"
            "\n"
            "  if (IsParentedTo(views().organizer_tray, views().browser_view)) {\n",
        ),
        (
            "      int top_offset = vertical_tab_strip_animation.top_offset;\n"
            "      if (zen.enabled) {\n"
            "        top_offset = ScaleExtent(top_offset, zen.top_chrome_ratio);\n"
            "      }\n",
            "      int top_offset = vertical_tab_strip_animation.top_offset;\n"
            "      if (zen.enabled) {\n"
            "        top_offset = ScaleExtent(top_offset, zen.top_chrome_ratio);\n"
            "      }\n"
            "      if (breezer_full_height_sidebar) {\n"
            "        top_offset = 0;\n"
            "      }\n",
        ),
        (
            "      if (zen.floating_vertical_tab_strip) {\n"
            "        vertical_tab_strip_bounds = SlideBoundsFromSide(\n"
            "            vertical_tab_strip_bounds, params.visual_client_area,\n"
            "            zen.side_chrome_ratio, vertical_right_aligned);\n"
            "      }\n",
            "      if (zen.floating_vertical_tab_strip) {\n"
            "        vertical_tab_strip_bounds = SlideBoundsFromSide(\n"
            "            vertical_tab_strip_bounds, params.visual_client_area,\n"
            "            zen.side_chrome_ratio, vertical_right_aligned);\n"
            "      }\n"
            "      // The toolbar clears the visible width, including hover expansion\n"
            "      // which overlaps the page without changing the content inset.\n"
            "      if (breezer_full_height_sidebar) {\n"
            "        breezer_sidebar_edge =\n"
            "            vertical_tab_strip_bounds.right() +\n"
            "            ScaleExtent(zen.vertical_tab_strip_padding,\n"
            "                        zen.side_chrome_ratio);\n"
            "      }\n",
        ),
        # The top container is laid out beside the sidebar, in the area left
        # after the sidebar's inset, so it needs no bookmarks or separator shift.
        (
            "    // Calculate the params for laying out the top container.\n"
            "    const BrowserLayoutParams& parent_params =\n"
            "        layout_data_->tab_strip_type == TabStripType::kVertical\n"
            "            ? top_container_parent_params\n"
            "            : params;\n",
            "    // Calculate the params for laying out the top container.\n"
            "    const BrowserLayoutParams breezer_beside_sidebar_params =\n"
            "        BesideBreezerSidebar(params, breezer_sidebar_edge);\n"
            "    const BrowserLayoutParams& parent_params =\n"
            "        layout_data_->tab_strip_type == TabStripType::kVertical &&\n"
            "                !breezer_full_height_sidebar\n"
            "            ? top_container_parent_params\n"
            "            : breezer_beside_sidebar_params;\n",
        ),
        (
            "    if (layout_data_->tab_strip_type == TabStripType::kVertical &&\n"
            "        !zen.floating_vertical_tab_strip) {\n"
            "      auto& top_container_children = top_container_layout.children;\n",
            "    if (layout_data_->tab_strip_type == TabStripType::kVertical &&\n"
            "        !zen.floating_vertical_tab_strip && !breezer_full_height_sidebar) {\n"
            "      auto& top_container_children = top_container_layout.children;\n",
        ),
        (
            "    views().vertical_tab_strip_region_view->SetHasLeadingExclusionForLayout(\n"
            "        has_leading_exclusion);\n",
            "    views().vertical_tab_strip_region_view->SetHasLeadingExclusionForLayout(\n"
            "        has_leading_exclusion);\n"
            "    // The band matches the toolbar row beside the sidebar, in the sidebar's\n"
            "    // coordinates; a floating sidebar is inset from the window's top and\n"
            "    // leading edges.\n"
            "    views().vertical_tab_strip_region_view->SetBreezerTitlebarForLayout(\n"
            "        breezer_full_height_sidebar\n"
            "            ? vertical_tab_strip_animation.top_offset -\n"
            "                  zen.vertical_tab_strip_top_padding\n"
            "            : 0,\n"
            "        base::ClampCeil(\n"
            "            browser_params.leading_exclusion.ContentWithPadding().width()) -\n"
            "            tabstrip_bounds->x());\n",
        ),
        # A full-height floating sidebar starts at the window top, beside the
        # top bar rather than below it.
        (
            "    if (zen.floating_vertical_tab_strip && zen.TopChromeVisible() &&\n"
            "        top_container_layout.bounds.height() > 0) {\n",
            "    if (zen.floating_vertical_tab_strip && zen.TopChromeVisible() &&\n"
            "        !breezer_full_height_sidebar &&\n"
            "        top_container_layout.bounds.height() > 0) {\n",
        ),
        # The top container is laid out here instead while the assistant panel
        # shares the toolbar row.
        (
            "    const gfx::Rect top_container_local_bounds = CalculateTopContainerLayout(\n"
            "        top_container_layout,\n"
            "        params.InLocalCoordinates(params.visual_client_area), needs_exclusion);\n"
            "    top_container_layout.bounds =\n"
            "        GetTopContainerBoundsInParent(top_container_local_bounds, params);\n",
            "    const BrowserLayoutParams top_container_params =\n"
            "        BesideBreezerSidebar(params, breezer_sidebar_edge);\n"
            "    const gfx::Rect top_container_local_bounds = CalculateTopContainerLayout(\n"
            "        top_container_layout,\n"
            "        top_container_params.InLocalCoordinates(\n"
            "            top_container_params.visual_client_area),\n"
            "        needs_exclusion);\n"
            "    top_container_layout.bounds = GetTopContainerBoundsInParent(\n"
            "        top_container_local_bounds, top_container_params);\n",
        ),
    ]


def replacements():
    """Per-file (before, after) pairs, applied after the workspace replacements."""
    return {
        REGION: _region_replacements(),
        REGION_HEADER: _region_header_replacements(),
        LAYOUT: _layout_replacements(),
    }


def merge(base):
    """Returns `base` with these replacements appended after its own."""
    result = {name: list(pairs) for name, pairs in base.items()}
    for name, pairs in replacements().items():
        result.setdefault(name, []).extend(pairs)
    return result
