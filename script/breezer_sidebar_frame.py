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
  usable beside it. It starts at the window top with a square top, like the
  attached sidebar.
- An unpinned sidebar overlays the page as a drawer flush with the window edge
  and the top bar. Helium's 8 DIP inset showed a strip of the page around it.
- The sidebar address control never changes whether the top bar is pinned.
  The extensions menu it opens reveals an unpinned top bar first, because the
  menu is anchored there.
- The document fills the region edge to edge, so no frame-colored bands show
  above or below it, and it takes the region's rounded floating shape.
- The unpinned (zen mode) sidebar keeps its native resize edge, placed at the
  region's own right edge rather than in its parent's coordinates.

Zen mode with an auto-hiding top bar, a hidden floating sidebar, fullscreen,
a collapsed rail, a hidden autoHide sidebar, a right-aligned sidebar, and
windows that show Chromium's own tab rows keep the upstream layout.
"""

REGION = "chrome/browser/ui/views/frame/vertical_tab_strip_region_view.cc"
REGION_HEADER = "chrome/browser/ui/views/frame/vertical_tab_strip_region_view.h"
REGION_TEST = "chrome/browser/ui/views/frame/vertical_tab_strip_region_view_browsertest.cc"
BROWSER_VIEW = "chrome/browser/ui/views/frame/browser_view.cc"
BROWSER_VIEW_HEADER = "chrome/browser/ui/views/frame/browser_view.h"
EXTENSIONS_TOOLBAR = "chrome/browser/ui/views/extensions/extensions_toolbar_desktop.cc"
LAYOUT = "chrome/browser/ui/views/frame/layout/browser_view_tabbed_layout_impl.cc"
TOOLBAR = "chrome/browser/ui/views/toolbar/toolbar_view.cc"
UI_FEATURES = "chrome/browser/ui/ui_features.cc"
FRAME_MATERIALS = "chrome/browser/ui/views/helium/native_frame_materials.cc"
MAC_WIDGET = "chrome/browser/ui/views/frame/browser_native_widget_mac.mm"


def _browser_view_replacements():
    pinned = """bool BrowserView::IsZenModeTopChromePinned() const {
  return zen_mode_enabled_ && browser_->GetProfile()->GetPrefs()->GetBoolean(
                                  prefs::kHeliumZenModeTopChromePinned);
}
"""
    # The saved "Always show the top bar" value decides the pin on its own, so
    # the sidebar address control cannot hide the top bar on any page.
    sidebar_address = """namespace {

bool UsesBreezerSidebarAddress(const BrowserView& view) {
  const Profile* profile = view.GetProfile();
  return !profile->IsOffTheRecord() && view.ShouldDrawVerticalTabStrip() &&
         profile->GetPrefs()->GetBoolean(
             breezer_workspace::prefs::kSidebarAddressSearch);
}

bool UsesBreezerNewTabSearch(const BrowserView& view,
                            content::WebContents& contents) {
  if (view.GetProfile()->IsOffTheRecord()) {
    return false;
  }
  const GURL& url = contents.GetVisibleURL();
  return url == GURL(chrome::kChromeUINewTabURL) ||
         (url.SchemeIs("chrome-extension") &&
          url.host() == breezer_workspace::kExtensionId &&
          url.path() == "/newtab.html");
}

}  // namespace

""" + pinned
    menu_shown = """void BrowserView::AppMenuShown() {
"""
    reveal_for_menu = """void BrowserView::RevealTopChromeForExtensionsMenu() {
  // The menu is anchored to the toolbar, which needs its shown bounds first.
  // The open bubble then keeps the top bar revealed until it closes.
  if (zen_mode_enabled_) {
    RevealZenModeTopChromeImmediately();
  }
}

"""
    focus = """  // In zen mode, snap the toolbar to fully shown so the omnibox is visible"""
    return [
        (
            '#include "chrome/browser/ui/layout_constants.h"\n',
            '#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"\n'
            '#include "chrome/browser/ui/layout_constants.h"\n',
        ),
        (pinned, sidebar_address),
        (menu_shown, reveal_for_menu + menu_shown),
        (
            focus,
            """  if (!is_user_initiated) {
    auto* contents = GetActiveWebContents();
    const bool new_tab_search =
        contents && UsesBreezerNewTabSearch(*this, *contents);
    if (new_tab_search ||
        (zen_mode_enabled_ && !IsZenModeTopChromePinned() &&
         UsesBreezerSidebarAddress(*this))) {
      // Automatic New Tab focus belongs to the page. Explicit address
      // commands continue to reveal and focus the toolbar.
      if (contents) {
        contents->Focus();
      }
      return;
    }
  }

""" + focus,
        ),
    ]


def _browser_view_header_replacements():
    toggle = "  void ToggleZenModeTopChrome();\n"
    return [(
        toggle,
        toggle +
        "\n"
        "  // Breezer: shows an unpinned top bar before the extensions menu opens.\n"
        "  void RevealTopChromeForExtensionsMenu();\n",
    )]


def _extensions_toolbar_replacements():
    # ToggleExtensionsMenu is the entry point for callers outside the toolbar.
    # Clicking the toolbar button itself does not come through here.
    toggle = "void ExtensionsToolbarDesktop::ToggleExtensionsMenu() {\n"
    return [(
        toggle,
        toggle +
        "  if (BrowserView* const browser_view =\n"
        "          BrowserView::GetBrowserViewForBrowser(browser_)) {\n"
        "    browser_view->RevealTopChromeForExtensionsMenu();\n"
        "  }\n",
    )]


def _region_header_replacements():
    return [
        (
            '#include "base/memory/raw_ptr.h"\n',
            '#include "base/memory/raw_ptr.h"\n'
            '#include "base/memory/weak_ptr.h"\n',
        ),
        (
            '  base::CallbackListSubscription paint_as_active_subscription_;\n',
            '  base::CallbackListSubscription paint_as_active_subscription_;\n'
            '\n'
            '  base::WeakPtrFactory<VerticalTabStripRegionView> weak_factory_{this};\n',
        ),
        (
            "  void SetFloatingStyleForLayout(FloatingStyle style,\n"
            "                                 int corner_radius,\n"
            "                                 bool below_toolbar);\n",
            "  // Breezer: `at_window_top` squares the top of a strip that runs from\n"
            "  // the window top under the window controls, even a detached one.\n"
            "  void SetFloatingStyleForLayout(FloatingStyle style,\n"
            "                                 int corner_radius,\n"
            "                                 bool below_toolbar,\n"
            "                                 bool at_window_top);\n"
            "\n"
            "  // Breezer: whether this region shows the Breezer sidebar document.\n"
            "  bool HostsBreezerWorkspace() const;\n"
            "  bool IsBreezerAutoHideSidebar() const;\n"
            "  // Breezer: the window title bar band drawn over the top of the\n"
            "  // document, with the window controls covering `controls_width` at the\n"
            "  // leading edge. Zero height when the region starts below the toolbar.\n"
            "  void SetBreezerTitlebarForLayout(int height, int controls_width);\n",
        ),
        (
            "  bool floating_below_toolbar_ = false;\n",
            "  bool floating_below_toolbar_ = false;\n"
            "  bool floating_at_window_top_ = false;\n",
        ),
    ]


def _region_replacements():
    return [
        (
            '#include "base/time/time.h"\n',
            '#include "base/location.h"\n'
            '#include "base/task/sequenced_task_runner.h"\n'
            '#include "base/time/time.h"\n',
        ),
        (
            '  if (state == tabs::VerticalTabStripCollapseState::kExpanded ||\n'
            '      state == tabs::VerticalTabStripCollapseState::kCollapsed) {\n'
            '    UpdateExpandOnHoverState();\n'
            '  }\n',
            '  if (state == tabs::VerticalTabStripCollapseState::kExpanded ||\n'
            '      state == tabs::VerticalTabStripCollapseState::kCollapsed) {\n'
            '    // Collapse completion notifies us inside GroupData::OnAnimationEnded.\n'
            '    // A floating zen sidebar holds a keep-expanded lock, so evaluating\n'
            '    // hover here can start a new motion before the old callback clears\n'
            '    // current_motion_, leaving the new animator without a motion.\n'
            '    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(\n'
            '        FROM_HERE,\n'
            '        base::BindOnce(&VerticalTabStripRegionView::UpdateExpandOnHoverState,\n'
            '                       weak_factory_.GetWeakPtr(), std::nullopt));\n'
            '  }\n',
        ),
        (
            '  if (IsHitInView(bottom_button_container_, point)) {\n',
            '  if (bottom_button_container_->GetVisible() &&\n'
            '      IsHitInView(bottom_button_container_, point)) {\n',
        ),
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
            "// where it joins the toolbar or the window top.\n"
            "gfx::RoundedCornersF BreezerWorkspaceCorners(\n"
            "    VerticalTabStripRegionView::FloatingStyle style,\n"
            "    int corner_radius,\n"
            "    bool below_toolbar,\n"
            "    bool at_window_top) {\n"
            "  using FloatingStyle = VerticalTabStripRegionView::FloatingStyle;\n"
            "  if (style == FloatingStyle::kNone) {\n"
            "    return gfx::RoundedCornersF();\n"
            "  }\n"
            "  const bool rtl = base::i18n::IsRTL();\n"
            "  const bool round_top =\n"
            "      (style == FloatingStyle::kDetached && !at_window_top) || !below_toolbar;\n"
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
            "  if (resize_area_->GetVisible() && IsHitInView(resize_area_, point)) {\n"
            "    return false;\n"
            "  }\n"
            "\n"
            "#if BUILDFLAG(ENABLE_EXTENSIONS)\n"
            "  // Classify the document before hidden native controls, which can retain\n"
            "  // stale bounds. AppKit drops caption hits before reaching the WebView.\n"
            "  if (BreezerWorkspaceView* const workspace = FindBreezerWorkspace(this);\n"
            "      workspace && workspace->IsDrawn() && IsHitInView(workspace, point)) {\n"
            "    return workspace->IsPointInTitlebar(\n"
            "        views::View::ConvertPointToTarget(this, workspace, point));\n"
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
            "    // A hidden auto-hide strip is only a reveal edge. Do not paint\n"
            "    // a six-pixel slice of the document's controls into that edge.\n"
            "    // An unavailable (closed or crashed) document stays hidden, as\n"
            "    // UpdateAvailability() left it, so the native tabs keep the space.\n"
            "    workspace->SetVisible(\n"
            "        workspace->is_available() &&\n"
            "        (!IsBreezerAutoHideSidebar() ||\n"
            "         width() > BreezerCollapsedWidth(browser_view()->browser())));\n"
            "    workspace->SetCornerRadii(BreezerWorkspaceCorners(\n"
            "        floating_style_, floating_corner_radius_, floating_below_toolbar_,\n"
            "        floating_at_window_top_));\n"
            "  }\n"
            "#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n",
        ),
        (
            "void VerticalTabStripRegionView::UpdateResizeAreaVisibility() {\n"
            "  if (floating_style_ != FloatingStyle::kNone) {\n",
            "void VerticalTabStripRegionView::UpdateResizeAreaVisibility() {\n"
            "  // Breezer's unpinned (zen mode) sidebar keeps its resize edge.\n"
            "  if (floating_style_ != FloatingStyle::kNone &&\n"
            "      !(HostsBreezerWorkspace() &&\n"
            "        browser_view()->IsZenModeEnabledForLayout() &&\n"
            "        !browser_view()->IsZenModeSideChromePinned())) {\n",
        ),
        (
            "void VerticalTabStripRegionView::SetFloatingStyleForLayout(FloatingStyle style,\n"
            "                                                           int corner_radius,\n"
            "                                                           bool below_toolbar) {\n"
            "  if (floating_style_ == style && floating_corner_radius_ == corner_radius &&\n"
            "      floating_below_toolbar_ == below_toolbar) {\n"
            "    return;\n"
            "  }\n"
            "  floating_style_ = style;\n"
            "  floating_corner_radius_ = corner_radius;\n"
            "  floating_below_toolbar_ = below_toolbar;\n",
            "void VerticalTabStripRegionView::SetFloatingStyleForLayout(FloatingStyle style,\n"
            "                                                           int corner_radius,\n"
            "                                                           bool below_toolbar,\n"
            "                                                           bool at_window_top) {\n"
            "  if (floating_style_ == style && floating_corner_radius_ == corner_radius &&\n"
            "      floating_below_toolbar_ == below_toolbar &&\n"
            "      floating_at_window_top_ == at_window_top) {\n"
            "    return;\n"
            "  }\n"
            "  floating_style_ = style;\n"
            "  floating_corner_radius_ = corner_radius;\n"
            "  floating_below_toolbar_ = below_toolbar;\n"
            "  floating_at_window_top_ = at_window_top;\n",
        ),
        (
            "    const bool round_top = style == FloatingStyle::kDetached || !below_toolbar;\n",
            "    // Breezer: a detached strip running from the window top joins it square.\n"
            "    const bool round_top =\n"
            "        (style == FloatingStyle::kDetached && !at_window_top) ||\n"
            "        !below_toolbar;\n",
        ),
    ]


def _region_test_replacements():
    anchor = (
        'IN_PROC_BROWSER_TEST_F(VerticalTabStripRegionViewTest,\n'
        '                       SeparatorVisibilityChangesWithCollapsedState) {\n'
    )
    tests = '''IN_PROC_BROWSER_TEST_F(VerticalTabStripRegionViewTest,
                       BreezerFloatingCollapseKeepsHoverMotion) {
  auto rich_animations = gfx::AnimationTestApi::SetRichAnimationRenderMode(
      gfx::Animation::RichAnimationRenderMode::FORCE_ENABLED);
  gfx::ScopedAnimationDurationScaleMode duration(
      gfx::ScopedAnimationDurationScaleMode::NORMAL_DURATION);
  auto* prefs = browser()->GetProfile()->GetPrefs();
  prefs->SetBoolean(prefs::kHeliumZenMode, true);
  prefs->SetBoolean(prefs::kHeliumZenModeSidebarPinned, false);
  SetupExpandedVerticalTabStrip();

  for (int attempt = 0; attempt < 3; ++attempt) {
    state_controller()->RequestCollapse(true);
    // Collapse completion holds a zen keep-expanded lock. The hover motion
    // must start after GroupData has finished clearing the collapse motion.
    ASSERT_TRUE(base::test::RunUntil([&]() {
      return state_controller()->IsCollapsed() &&
             region_view()->is_expanded_on_hover() && !IsAnimatingSize();
    }));
    state_controller()->RequestCollapse(false);
    ASSERT_TRUE(base::test::RunUntil([&]() {
      return !state_controller()->IsCollapsed() && !IsAnimatingSize();
    }));
  }
}

IN_PROC_BROWSER_TEST_F(VerticalTabStripRegionViewTest,
                       BreezerHiddenControlsDoNotClaimCaption) {
  SetupExpandedVerticalTabStrip();
  auto* bottom = region_view()->GetBottomContainer();
  // Hidden Views retain their old bounds and HitTestPoint ignores visibility.
  bottom->SetBoundsRect(gfx::Rect(0, 0, 200, 200));
  for (views::View* child : bottom->children()) {
    child->SetVisible(false);
  }
  bottom->SetVisible(false);
  gfx::Point point(20, 100);
  views::View::ConvertPointToTarget(bottom, region_view(), &point);
  ASSERT_TRUE(region_view()->GetLocalBounds().Contains(point));
  EXPECT_FALSE(region_view()->IsPositionInWindowCaption(point));
}

'''
    return [
        (
            '#include "chrome/browser/ui/views/tabs/vertical/vertical_tab_strip_top_container.h"\n',
            '#include "chrome/browser/ui/views/tabs/vertical/vertical_tab_strip_top_container.h"\n'
            '#include "chrome/browser/ui/views/tabs/vertical/vertical_tab_strip_bottom_container.h"\n'
            '#include "components/prefs/pref_service.h"\n'
            '#include "ui/gfx/animation/animation_test_api.h"\n',
        ),
        (anchor, tests + anchor),
    ]


def _layout_replacements():
    zen_state = (
        "ZenModeLayoutState zen = GetZenModeLayoutState(\n"
        "      delegate(), layout_data_->tab_strip_type == TabStripType::kVertical);\n"
    )
    after_zen = "  std::optional<int> dynamic_tab_strip_top;\n"
    detached = (
        "    if (zen.floating_vertical_tab_strip) {\n"
        "      floating_style = FloatingStyle::kDetached;\n"
    )
    return [
        (
            "  const " + zen_state + after_zen,
            "  " + zen_state +
            "  // Breezer: an unpinned sidebar is a drawer along the window edge. Insets\n"
            "  // around it would show strips of the page in a different color.\n"
            "  const bool breezer_drawer =\n"
            "      zen.floating_vertical_tab_strip &&\n"
            "      IsParentedTo(views().vertical_tab_strip_region_view,\n"
            "                   views().browser_view) &&\n"
            "      views().vertical_tab_strip_region_view->HostsBreezerWorkspace();\n"
            "  if (breezer_drawer) {\n"
            "    zen.vertical_tab_strip_padding = 0;\n"
            "    zen.vertical_tab_strip_top_padding = 0;\n"
            "  }\n" + after_zen,
        ),
        (
            detached,
            "    if (breezer_drawer) {\n"
            "      floating_style = vertical_right_aligned\n"
            "                           ? FloatingStyle::kAttachedTrailing\n"
            "                           : FloatingStyle::kAttachedLeading;\n"
            "    } else if (zen.floating_vertical_tab_strip) {\n"
            "      floating_style = FloatingStyle::kDetached;\n",
        ),
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
            "      }\n"
            "\n"
            "      const int vertical_tab_strip_height =\n"
            "          std::max(0, params.visual_client_area.height() - top_offset -\n"
            "                          zen.vertical_tab_strip_top_padding -\n"
            "                          zen.vertical_tab_strip_padding);\n"
            "      vertical_tab_strip_bounds = {\n"
            "          vertical_tab_strip_x,\n"
            "          params.visual_client_area.y() + top_offset +\n"
            "              zen.vertical_tab_strip_top_padding,\n"
            "          vertical_tab_strip_width, vertical_tab_strip_height};\n",
            "      int top_offset = vertical_tab_strip_animation.top_offset;\n"
            "      if (zen.enabled) {\n"
            "        top_offset = ScaleExtent(top_offset, zen.top_chrome_ratio);\n"
            "      }\n"
            "      // A floating sidebar running full height joins the window top too,\n"
            "      // rather than starting below the toolbar row.\n"
            "      if (breezer_full_height_sidebar) {\n"
            "        top_offset = 0;\n"
            "      }\n"
            "\n"
            "      const int vertical_tab_strip_height =\n"
            "          std::max(0, params.visual_client_area.height() - top_offset -\n"
            "                          zen.vertical_tab_strip_top_padding -\n"
            "                          zen.vertical_tab_strip_padding);\n"
            "      vertical_tab_strip_bounds = {\n"
            "          vertical_tab_strip_x,\n"
            "          params.visual_client_area.y() + top_offset +\n"
            "              zen.vertical_tab_strip_top_padding,\n"
            "          vertical_tab_strip_width, vertical_tab_strip_height};\n",
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
            "        breezer_sidebar_edge = vertical_tab_strip_bounds.right();\n"
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
            "    // The band matches the toolbar row beside the sidebar. A full-height\n"
            "    // sidebar starts at the window top, so the row's height is the band's.\n"
            "    views().vertical_tab_strip_region_view->SetBreezerTitlebarForLayout(\n"
            "        breezer_full_height_sidebar ? vertical_tab_strip_animation.top_offset\n"
            "                                    : 0,\n"
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
        (
            "    views().vertical_tab_strip_region_view->SetFloatingStyleForLayout(\n"
            "        floating_style, floating_corner_radius, below_toolbar);\n",
            "    views().vertical_tab_strip_region_view->SetFloatingStyleForLayout(\n"
            "        floating_style, floating_corner_radius, below_toolbar,\n"
            "        /*at_window_top=*/breezer_full_height_sidebar);\n",
        ),
    ]



def _toolbar_replacements():
    press = "void ToolbarView::VerticalTabsCollapseButtonPressed(const ui::Event& event) {\n"
    return [
        (
            press,
            press +
            "  if (browser_view_->IsZenModeEnabledForLayout() &&\n"
            "      !browser_->GetProfile()->IsOffTheRecord()) {\n"
            "    browser_view_->ToggleZenModeSideChrome();\n"
            "    return;\n"
            "  }\n",
        ),
        (
            "  const bool should_show = controller && IsVerticalLayout() &&\n"
            "                           show_vertical_tabs_collapse_button_.GetValue() &&\n"
            "                           !zen_hide;\n",
            "  const bool breezer_sidebar = !browser_->GetProfile()->IsOffTheRecord();\n"
            "  const bool should_show = controller && IsVerticalLayout() &&\n"
            "      (breezer_sidebar ||\n"
            "       (show_vertical_tabs_collapse_button_.GetValue() && !zen_hide));\n",
        ),
        (
            "  const int text_id = controller->IsCollapsed() ? IDS_EXPAND_VERTICAL_TABS\n"
            "                                                : IDS_COLLAPSE_VERTICAL_TABS;\n",
            "  const bool collapsed = breezer_sidebar &&\n"
            "                                 browser_view_->IsZenModeEnabledForLayout()\n"
            "                             ? zen_hide\n"
            "                             : controller->IsCollapsed();\n"
            "  const int text_id = collapsed ? IDS_EXPAND_VERTICAL_TABS\n"
            "                                : IDS_COLLAPSE_VERTICAL_TABS;\n",
        ),
    ]


def replacements():
    """Per-file (before, after) pairs, applied after the workspace replacements."""
    return {
        REGION: _region_replacements(),
        REGION_HEADER: _region_header_replacements(),
        REGION_TEST: _region_test_replacements(),
        BROWSER_VIEW: _browser_view_replacements(),
        BROWSER_VIEW_HEADER: _browser_view_header_replacements(),
        EXTENSIONS_TOOLBAR: _extensions_toolbar_replacements(),
        LAYOUT: _layout_replacements(),
        TOOLBAR: _toolbar_replacements(),
        UI_FEATURES: [(
            "BASE_FEATURE(kHeliumNativeFrameMaterials, base::FEATURE_DISABLED_BY_DEFAULT);\n",
            "BASE_FEATURE(kHeliumNativeFrameMaterials, base::FEATURE_ENABLED_BY_DEFAULT);\n",
        )],
        FRAME_MATERIALS: [(
            "  return profile &&\n"
            "         profile->GetPrefs()->GetBoolean(prefs::kHeliumNativeFrameMaterials);\n",
            "  const auto* widget = browser_view->GetWidget();\n"
            "  return profile && !profile->IsOffTheRecord() &&\n"
            "         !(widget && widget->IsFullscreen()) &&\n"
            "         profile->GetPrefs()->GetBoolean(prefs::kHeliumNativeFrameMaterials);\n",
        )],
        MAC_WIDGET: [(
            "    browser_view_->FullscreenStateChanged();\n",
            "    browser_view_->FullscreenStateChanged();\n"
            "    UpdateBackground();\n",
        )],
    }


def merge(base):
    """Returns `base` with these replacements appended after its own."""
    result = {name: list(pairs) for name, pairs in base.items()}
    for name, pairs in replacements().items():
        result.setdefault(name, []).extend(pairs)
    return result
