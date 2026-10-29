#!/usr/bin/env python3
"""Apply or verify Breezer's bounded native workspace integration.

Run after Chromium and Helium source preparation. The overlay replaces only
known anchors in native source and adds files from features/workspace/native.
Every anchor and added file is validated before anything is written. It never
changes build output or removes source files.
"""

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import tempfile

import breezer_sidebar_frame as sidebar_frame


ROOT = Path(__file__).resolve().parent.parent
NATIVE = ROOT / "features/workspace/native"
COMPONENT_ID = "namgcidocfgliiedlkdafcmifpdfiakj"
# SHA-1 of COMPONENT_ID, as used by feature allowlists.
COMPONENT_ID_HASH = "C856DA2FDA3086658F6BF5FDAE63C5D4686C8E68"

REGION = "chrome/browser/ui/views/frame/vertical_tab_strip_region_view.cc"
LAYOUT_CONTROLLER = "chrome/browser/ui/helium/helium_layout_state_controller.cc"
VERTICAL_CONTROLLER = "chrome/browser/ui/tabs/vertical_tab_strip_state_controller_impl.cc"
WINDOW_FEATURES = "chrome/browser/ui/browser_window/internal/browser_window_features.cc"


def _region_replacements():
    return [
        (
            '#include "chrome/browser/ui/views/frame/base_tab_strip_region_view.h"\n',
            '#include "chrome/browser/ui/views/frame/base_tab_strip_region_view.h"\n'
            '#include "extensions/buildflags/buildflags.h"\n'
            '#if BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '#include "chrome/browser/ui/views/frame/breezer_workspace_view.h"\n'
            '#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n',
        ),
        (
            'constexpr int kDefaultWidthSnapDistance = 6;\n',
            'constexpr int kDefaultWidthSnapDistance = 6;\n'
            '\n'
            '#if BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '// Breezer\'s sidebar document, when this region hosts one.\n'
            'BreezerWorkspaceView* FindBreezerWorkspace(views::View* region) {\n'
            '  return views::AsViewClass<BreezerWorkspaceView>(\n'
            '      region->GetViewByID(BreezerWorkspaceView::kViewId));\n'
            '}\n'
            '#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n',
        ),
        (
            'views::View* VerticalTabStripRegionView::GetDefaultFocusableChild() {\n'
            '  tabs::TabInterface* active_tab = tab_strip_model()->GetActiveTab();\n',
            'views::View* VerticalTabStripRegionView::GetDefaultFocusableChild() {\n'
            '#if BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '  if (BreezerWorkspaceView* const workspace = FindBreezerWorkspace(this);\n'
            '      workspace && workspace->is_available()) {\n'
            '    return workspace->GetFocusableView();\n'
            '  }\n'
            '#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '  tabs::TabInterface* active_tab = tab_strip_model()->GetActiveTab();\n',
        ),
        (
            '  resize_area_width_ = collapsed ? kCollapsedResizeAreaWidth : kResizeAreaWidth;\n',
            '  resize_area_width_ = collapsed ? kCollapsedResizeAreaWidth : kResizeAreaWidth;\n'
            '\n'
            '  // Follow width changes made outside a drag (Breezer settings apply the\n'
            '  // sidebar width through the state controller).\n'
            '  if (!starting_width_on_resize_.has_value() &&\n'
            '      target_collapse_state_.uncollapsed_width !=\n'
            '          state_controller_->GetUncollapsedWidth()) {\n'
            '    target_collapse_state_.uncollapsed_width =\n'
            '        state_controller_->GetUncollapsedWidth();\n'
            '    InvalidateLayout();\n'
            '  }\n',
        ),
        (
            '  content_parent->AddChildViewAt(std::move(view),\n'
            '                                 bottom_container_index.value());\n'
            '\n'
            '  // Pre-set the animation values to the appropriate state.\n',
            '#if BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '  views::View* const native_tab_strip = view.get();\n'
            '#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '  content_parent->AddChildViewAt(std::move(view),\n'
            '                                 bottom_container_index.value());\n'
            '\n'
            '#if BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '  // Breezer shows its own sidebar document in place of the native tab rows.\n'
            '  // The native tab strip stays attached (hidden) so its controllers, tab\n'
            '  // anchors and drag targets keep working, and it is shown again whenever\n'
            '  // the document is unavailable.\n'
            '  auto workspace = std::make_unique<BreezerWorkspaceView>(\n'
            '      *browser_view()->browser(),\n'
            '      base::BindRepeating(\n'
            '          [](VerticalTabStripRegionView* region, bool available) {\n'
            '            if (views::View* const tab_strip = region->tab_strip_view()) {\n'
            '              tab_strip->SetVisible(!available);\n'
            '            }\n'
            '            region->bottom_button_container_->SetVisible(!available);\n'
            '            region->InvalidateLayout();\n'
            '          },\n'
            '          base::Unretained(this)));\n'
            '  workspace->SetProperty(\n'
            '      views::kFlexBehaviorKey,\n'
            '      views::FlexSpecification(views::MinimumFlexSizeRule::kScaleToZero,\n'
            '                               views::MaximumFlexSizeRule::kUnbounded));\n'
            '  const bool workspace_available = workspace->is_available();\n'
            '  content_parent->AddChildViewAt(\n'
            '      std::move(workspace), *content_parent->GetIndexOf(native_tab_strip));\n'
            '  native_tab_strip->SetVisible(!workspace_available);\n'
            '  bottom_button_container_->SetVisible(!workspace_available);\n'
            '#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '\n'
            '  // Pre-set the animation values to the appropriate state.\n',
        ),
        (
            '  omnibox_tab_helper_observation_.Reset();\n'
            '  ResetExpandOnHoverTimers();\n'
            '  is_expanded_on_hover_ = false;\n'
            '  return BaseTabStripRegionView::RemoveTabStripView(view);\n',
            '  omnibox_tab_helper_observation_.Reset();\n'
            '  ResetExpandOnHoverTimers();\n'
            '  is_expanded_on_hover_ = false;\n'
            '#if BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '  if (BreezerWorkspaceView* const workspace = FindBreezerWorkspace(this)) {\n'
            '    // A layout change can be requested from inside the document, so its\n'
            '    // host is released in a later task before this view is destroyed.\n'
            '    workspace->ReleaseExtensionContentSoon();\n'
            '    workspace->parent()->RemoveChildViewT(workspace).reset();\n'
            '  }\n'
            '  view->SetVisible(true);\n'
            '  bottom_button_container_->SetVisible(true);\n'
            '#endif  // BUILDFLAG(ENABLE_EXTENSIONS)\n'
            '  return BaseTabStripRegionView::RemoveTabStripView(view);\n',
        ),
    ] + _sidebar_mode_replacements()


def _sidebar_mode_replacements():
    return [
        (
            '#include "chrome/browser/ui/color/chrome_color_id.h"\n',
            '#include "chrome/browser/ui/color/chrome_color_id.h"\n'
            '#include "chrome/browser/profiles/profile.h"\n'
            '#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"\n'
            '#include "components/prefs/pref_service.h"\n',
        ),
        (
            'constexpr int kResizeAreaWidth = 5;\n',
            'constexpr int kResizeAreaWidth = 5;\n'
            '\n'
            'int BreezerCollapsedWidth(BrowserWindowInterface* browser) {\n'
            '  return browser->GetProfile()->GetPrefs()->GetString(\n'
            '             breezer_workspace::prefs::kSidebarMode) == "autoHide"\n'
            '             ? 6\n'
            '             : VerticalTabStripRegionView::kCollapsedWidth;\n'
            '}\n',
        ),
        (
            '                         ? kCollapsedWidth\n',
            '                         ? BreezerCollapsedWidth(browser_view()->browser())\n',
        ),
        (
            '  const int expand_amount =\n'
            '      std::max(0, target_collapse_state_.uncollapsed_width - kCollapsedWidth);\n',
            '  const int collapsed_width = BreezerCollapsedWidth(browser_view()->browser());\n'
            '  const int expand_amount =\n'
            '      std::max(0, target_collapse_state_.uncollapsed_width - collapsed_width);\n',
        ),
        ('  size.set_width(kCollapsedWidth +\n', '  size.set_width(collapsed_width +\n'),
    ]


def _freezer_replacements():
    return [
        ('#include "content/public/browser/web_contents.h"\n',
         '#include "content/public/browser/web_contents.h"\n#include "url/gurl.h"\n'),
        ('  // A visible page should not be frozen.\n',
         '  // Breezer workspace and assistant documents are browser UI, not idle tabs.\n'
         '  // Freezing a native UI host also freezes its shared extension renderer.\n'
         '  const GURL& url = page_node->GetMainFrameUrl();\n'
         '  if (url.SchemeIs("chrome-extension") &&\n'
         '      url.GetHost() == "namgcidocfgliiedlkdafcmifpdfiakj") {\n'
         '    return;\n'
         '  }\n\n'
         '  // A visible page should not be frozen.\n'),
    ]


def _layout_controller_replacements():
    return [
        (
            '#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"\n'
            '#include "chrome/common/pref_names.h"\n'
            '#include "components/prefs/pref_service.h"\n',
            '#include "base/containers/flat_set.h"\n'
            '#include "base/no_destructor.h"\n'
            '#include "chrome/browser/profiles/profile.h"\n'
            '#include "chrome/browser/themes/theme_service.h"\n'
            '#include "chrome/browser/themes/theme_service_factory.h"\n'
            '#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"\n'
            '#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"\n'
            '#include "chrome/common/pref_names.h"\n'
            '#include "components/bookmarks/common/bookmark_pref_names.h"\n'
            '#include "components/prefs/pref_service.h"\n'
            '#include "ui/base/mojom/themes.mojom.h"\n',
        ),
        (
            'DEFINE_USER_DATA(HeliumLayoutStateController);\n',
            'DEFINE_USER_DATA(HeliumLayoutStateController);\n'
            '\n'
            'namespace {\n'
            '\n'
            '// Breezer keeps private windows on the classic layout. They share the\n'
            '// regular profile\'s layout preference, so their controllers are tracked\n'
            '// here rather than in the widely included header.\n'
            'base::flat_set<const HeliumLayoutStateController*>&\n'
            'OffTheRecordControllers() {\n'
            '  static base::NoDestructor<\n'
            '      base::flat_set<const HeliumLayoutStateController*>>\n'
            '      controllers;\n'
            '  return *controllers;\n'
            '}\n'
            '\n'
            'bool IsUserModifiable(PrefService* prefs, std::string_view path) {\n'
            '  const PrefService::Preference* const pref = prefs->FindPreference(path);\n'
            '  return pref && pref->IsUserModifiable();\n'
            '}\n'
            '\n'
            '// Explicit saved choices, managed prefs and extension-controlled prefs win.\n'
            'bool CanInitializePref(PrefService* prefs, std::string_view path) {\n'
            '  const auto* pref = prefs->FindPreference(path);\n'
            '  return pref && pref->IsUserModifiable() && pref->IsDefaultValue() &&\n'
            '         !prefs->GetUserPrefValue(path);\n'
            '}\n'
            '\n'
            'void MaybeInitializeBreezerWorkspace(Profile* profile, PrefService* prefs) {\n'
            '  if (!IsUserModifiable(prefs,\n'
            '                        breezer_workspace::prefs::kAppearanceDefaultsVersion) ||\n'
            '      prefs->GetInteger(breezer_workspace::prefs::kAppearanceDefaultsVersion) >=\n'
            '          breezer_workspace::kAppearanceDefaultsVersion) {\n'
            '    return;\n'
            '  }\n'
            '  // v1 wrote layout, width, bookmarks and theme once. Preserve those profiles.\n'
            '  // Profiles predating v1 only receive defaults for prefs with no saved choice.\n'
            '  if (!prefs->GetBoolean(breezer_workspace::prefs::kInitialized)) {\n'
            '    if (CanInitializePref(prefs, prefs::kHeliumLayout)) {\n'
            '      prefs->SetInteger(prefs::kHeliumLayout,\n'
            '                        std::to_underlying(HeliumLayoutType::kVertical));\n'
            '    }\n'
            '    if (CanInitializePref(prefs, prefs::kHeliumVerticalRightAligned)) {\n'
            '      prefs->SetBoolean(prefs::kHeliumVerticalRightAligned, false);\n'
            '    }\n'
            '    if (CanInitializePref(prefs, bookmarks::prefs::kShowBookmarkBar)) {\n'
            '      prefs->SetBoolean(bookmarks::prefs::kShowBookmarkBar, false);\n'
            '    }\n'
            '    if (CanInitializePref(prefs, bookmarks::prefs::kBookmarkBarVisibilityState)) {\n'
            '      // Persisted Chromium mode: only show on the new-tab page.\n'
            '      prefs->SetInteger(bookmarks::prefs::kBookmarkBarVisibilityState, 1);\n'
            '    }\n'
            '    if (CanInitializePref(prefs, prefs::kVerticalTabsUncollapsedWidth)) {\n'
            '      prefs->SetInteger(prefs::kVerticalTabsUncollapsedWidth,\n'
            '                        breezer_workspace::kDefaultSidebarWidth);\n'
            '    }\n'
            '    static_assert(breezer_workspace::kThemes[0].name ==\n'
            '                  breezer_workspace::kDefaultTheme);\n'
            '    ThemeService* const theme_service =\n'
            '        ThemeServiceFactory::GetForProfile(profile);\n'
            '    if (theme_service && !theme_service->UsingPolicyTheme() &&\n'
            '        !theme_service->GetIsGrayscale() &&\n'
            '        CanInitializePref(prefs, prefs::kCurrentThemeID) &&\n'
            '        CanInitializePref(prefs, prefs::kUserColor)) {\n'
            '      theme_service->SetUserColorAndBrowserColorVariant(\n'
            '          breezer_workspace::kThemes[0].seed,\n'
            '          ui::mojom::BrowserColorVariant::kTonalSpot);\n'
            '    }\n'
            '    if (IsUserModifiable(prefs, breezer_workspace::prefs::kInitialized)) {\n'
            '      prefs->SetBoolean(breezer_workspace::prefs::kInitialized, true);\n'
            '    }\n'
            '  }\n'
            '  // v2 adopts the requested frameless/address bar defaults without interpreting\n'
            "  // the disabled native auto-expand switch or changing Breezer's autoHide mode.\n"
            '  const struct {\n'
            '    std::string_view path;\n'
            '    bool value;\n'
            '  } defaults[] = {\n'
            '      {prefs::kHeliumCenteredLocationBar, true},\n'
            '      {prefs::kHeliumMinimalLocationBar, true},\n'
            '      {prefs::kHeliumShowProgressBar, true},\n'
            '      {prefs::kHeliumZenMode, true},\n'
            '      {prefs::kHeliumZenModeSidebarPinned, false},\n'
            '      {prefs::kHeliumZenModeTopChromePinned, true},\n'
            '  };\n'
            '  for (const auto& setting : defaults) {\n'
            '    if (CanInitializePref(prefs, setting.path)) {\n'
            '      prefs->SetBoolean(setting.path, setting.value);\n'
            '    }\n'
            '  }\n'
            '  prefs->SetInteger(breezer_workspace::prefs::kAppearanceDefaultsVersion,\n'
            '                    breezer_workspace::kAppearanceDefaultsVersion);\n'
            '}\n'
            '\n'
            '}  // namespace\n',
        ),
        (
            '                                *this) {\n'
            '  pref_change_registrar_.Init(pref_service_);\n',
            '                                *this) {\n'
            '  // Runs before any observer is registered, so the one-time defaults do\n'
            '  // not notify half-built windows.\n'
            '  Profile* const profile = browser_window->GetProfile();\n'
            '  if (profile->IsOffTheRecord()) {\n'
            '    OffTheRecordControllers().insert(this);\n'
            '  } else {\n'
            '    MaybeInitializeBreezerWorkspace(profile, pref_service_);\n'
            '  }\n'
            '  pref_change_registrar_.Init(pref_service_);\n',
        ),
        (
            'HeliumLayoutStateController::~HeliumLayoutStateController() = default;\n',
            'HeliumLayoutStateController::~HeliumLayoutStateController() {\n'
            '  OffTheRecordControllers().erase(this);\n'
            '}\n',
        ),
        (
            'void HeliumLayoutStateController::SetBrowserLayout(HeliumLayoutType layout) {\n'
            '  pref_service_->SetInteger(prefs::kHeliumLayout, std::to_underlying(layout));\n',
            'void HeliumLayoutStateController::SetBrowserLayout(HeliumLayoutType layout) {\n'
            '  if (OffTheRecordControllers().contains(this)) {\n'
            '    return;\n'
            '  }\n'
            '  pref_service_->SetInteger(prefs::kHeliumLayout, std::to_underlying(layout));\n',
        ),
        (
            'HeliumLayoutType HeliumLayoutStateController::GetBrowserLayout() const {\n'
            '  int layout_value = pref_service_->GetInteger(prefs::kHeliumLayout);\n',
            'HeliumLayoutType HeliumLayoutStateController::GetBrowserLayout() const {\n'
            '  if (OffTheRecordControllers().contains(this)) {\n'
            '    return HeliumLayoutType::kClassic;\n'
            '  }\n'
            '  int layout_value = pref_service_->GetInteger(prefs::kHeliumLayout);\n',
        ),
    ]


def _vertical_controller_replacements():
    vertical_check = (
        "pref_service_->GetInteger(prefs::kHeliumLayout) ==\n"
        "{indent}std::to_underlying(HeliumLayoutType::kVertical);\n"
    )
    return [
        (
            "  if (IsVerticalTabsExpandOnHoverFeatureEnabled()) {\n",
            "  if (IsVerticalTabsExpandOnHoverFeatureEnabled() ||\n"
            "      !browser_window.GetProfile()->IsOffTheRecord()) {\n",
        ),
        (
            "namespace tabs {\n"
            "\n"
            "VerticalTabStripStateControllerImpl::VerticalTabStripStateControllerImpl(\n",
            "namespace tabs {\n"
            "\n"
            "namespace {\n"
            "\n"
            "// Breezer keeps private windows on the classic layout without reading or\n"
            "// changing the regular profile's layout choice for them.\n"
            "bool IsVerticalLayoutForWindow(BrowserWindowInterface& browser_window,\n"
            "                               PrefService* pref_service) {\n"
            "  return !browser_window.GetProfile()->IsOffTheRecord() &&\n"
            "         pref_service->GetInteger(prefs::kHeliumLayout) ==\n"
            "             std::to_underlying(HeliumLayoutType::kVertical);\n"
            "}\n"
            "\n"
            "}  // namespace\n"
            "\n"
            "VerticalTabStripStateControllerImpl::VerticalTabStripStateControllerImpl(\n",
        ),
        (
            "  is_vertical_tabs_enabled_ =\n      "
            + vertical_check.format(indent="      ")
            + "\n  pref_change_registrar_.AddMultiple(\n",
            "  is_vertical_tabs_enabled_ =\n"
            "      IsVerticalLayoutForWindow(browser_window, pref_service_);\n"
            "\n  pref_change_registrar_.AddMultiple(\n",
        ),
        (
            "void VerticalTabStripStateControllerImpl::SetVerticalTabsEnabled(bool enabled) {\n",
            "void VerticalTabStripStateControllerImpl::SetVerticalTabsEnabled(bool enabled) {\n"
            "  // Private windows stay classic and must not change the regular profile.\n"
            "  if (browser_window_->GetProfile()->IsOffTheRecord()) {\n"
            "    return;\n"
            "  }\n",
        ),
        (
            "void VerticalTabStripStateControllerImpl::OnModeChanged() {\n"
            "  const bool new_enabled =\n      "
            + vertical_check.format(indent="      "),
            "void VerticalTabStripStateControllerImpl::OnModeChanged() {\n"
            "  const bool new_enabled =\n"
            "      IsVerticalLayoutForWindow(*browser_window_, pref_service_);\n",
        ),
        (
            "    is_vertical_tabs_enabled_ =\n        "
            + vertical_check.format(indent="        ")
            + "    NotifyModeChanged();\n",
            "    is_vertical_tabs_enabled_ =\n"
            "        IsVerticalLayoutForWindow(*browser_window_, pref_service_);\n"
            "    NotifyModeChanged();\n",
        ),
    ]


def _window_features_replacements():
    creation = (
        "    helium_layout_state_controller_ =\n"
        "        GetUserDataFactory().CreateInstance<HeliumLayoutStateController>(\n"
        "            *browser, browser, profile->GetPrefs());\n"
    )
    restored = (
        "    std::optional<bool> restored_state_collapsed =\n"
        "        BrowserInitState::From(browser)->is_vertical_tabs_initially_collapsed();\n"
    )
    width_read = (
        "      restored_state_uncollapsed_width =\n"
        "          profile->GetPrefs()->GetInteger(prefs::kVerticalTabsUncollapsedWidth);\n"
        "    }\n"
        "\n"
    )
    return [
        (
            '#include "chrome/browser/ui/helium/helium_layout_state_controller.h"\n',
            '#include "chrome/browser/ui/helium/helium_layout_state_controller.h"\n'
            '#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"\n',
        ),
        # Create the layout controller (which applies Breezer's one-time profile
        # defaults) before the default sidebar width is read for this window.
        (
            restored,
            "    // Breezer: created first so its one-time profile defaults apply before\n"
            "    // the default sidebar width below is read.\n"
            + creation + "\n" + restored +
            '    if (profile->GetPrefs()->GetString(breezer_workspace::prefs::kSidebarMode) !=\n'
            '        "expanded") {\n'
            '      restored_state_collapsed = true;\n'
            '    }\n',
        ),
        (width_read + creation + "\n", width_read),
    ]


def _bookmark_bar_replacements():
    return [(
        '  return NewTabUI::IsNewTab(url) || NewTabPageUI::IsNewTabPageOrigin(url) ||\n',
        '  return url.IsAboutBlank() ||\n'
        '         (url.SchemeIs("chrome-extension") &&\n'
        f'          url.GetHost() == "{COMPONENT_ID}" &&\n'
        '          url.GetPath() == "/newtab.html") ||\n'
        '         NewTabUI::IsNewTab(url) || NewTabPageUI::IsNewTabPageOrigin(url) ||\n',
    )]


PEEK_DELEGATE = (
    "chrome/browser/ui/browser_web_contents_delegate/browser_web_contents_delegate.cc"
)
PEEK_THROTTLES = "chrome/browser/chrome_content_browser_client_navigation_throttles.cc"


def _peek_replacements():
    """Route favourite-tab links into chrome/browser/ui/views/breezer_peek."""
    return {
        PEEK_DELEGATE: [
            (
                '#include "chrome/browser/ui/views/frame/contents_web_view.h"\n',
                '#include "chrome/browser/ui/views/breezer_peek/breezer_peek.h"\n'
                '#include "chrome/browser/ui/views/frame/contents_web_view.h"\n',
            ),
            (
                '  // If the source is already split, navigate the other pane instead of\n',
                '  // Breezer: a foreground-tab link from a favourite\'s tab opens in a peek.\n'
                '  if (content::WebContents* const peek =\n'
                '          breezer_peek::MaybeShowURL(source, params)) {\n'
                '    return peek;\n'
                '  }\n'
                '\n'
                '  // If the source is already split, navigate the other pane instead of\n',
            ),
            (
                '    bool* was_blocked) {\n'
                '  FullscreenController* fullscreen_controller =\n',
                '    bool* was_blocked) {\n'
                '  // Breezer: a new foreground tab from a favourite\'s tab opens in a peek.\n'
                '  if (content::WebContents* const peek =\n'
                '          breezer_peek::MaybeShowNewContents(\n'
                '              source, new_contents, disposition, user_gesture)) {\n'
                '    return peek;\n'
                '  }\n'
                '  FullscreenController* fullscreen_controller =\n',
            ),
        ],
        "chrome/browser/ui/browser_web_contents_delegate/BUILD.gn": [
            (
                '      "//chrome/browser/ui/views:status_bubble",\n',
                '      "//chrome/browser/ui/views:status_bubble",\n'
                '      "//chrome/browser/ui/views/breezer_peek",\n',
            ),
        ],
        PEEK_THROTTLES: [
            (
                '#include "chrome/browser/ui/login/login_navigation_throttle.h"\n',
                '#include "chrome/browser/ui/login/login_navigation_throttle.h"\n'
                '#if !BUILDFLAG(IS_ANDROID)\n'
                '#include "chrome/browser/ui/views/breezer_peek/breezer_peek.h"\n'
                '#endif  // !BUILDFLAG(IS_ANDROID)\n',
            ),
            (
                '    page_load_metrics::MetricsNavigationThrottle::CreateAndAdd(registry);\n',
                '    page_load_metrics::MetricsNavigationThrottle::CreateAndAdd(registry);\n'
                '\n'
                '#if !BUILDFLAG(IS_ANDROID)\n'
                "    // Breezer: keeps a favourite's tab on its site; cross-site link\n"
                '    // clicks open in a peek.\n'
                '    breezer_peek::MaybeCreateAndAddNavigationThrottle(registry);\n'
                '#endif  // !BUILDFLAG(IS_ANDROID)\n',
            ),
        ],
        "chrome/browser/BUILD.gn": [
            (
                '      ":repost_form_warning_controller",\n',
                '      ":repost_form_warning_controller",\n'
                '      "//chrome/browser/ui/views/breezer_peek",\n',
            ),
        ],
    }


def replacements():
    return sidebar_frame.merge({
        REGION: _region_replacements(),
        "chrome/browser/ui/bookmarks/bookmark_bar_controller.cc": _bookmark_bar_replacements(),
        "components/performance_manager/freezing/freezer.cc": _freezer_replacements(),
        LAYOUT_CONTROLLER: _layout_controller_replacements(),
        VERTICAL_CONTROLLER: _vertical_controller_replacements(),
        WINDOW_FEATURES: _window_features_replacements(),
        "chrome/browser/ui/chrome_pages.cc": [
            (
                '#include "extensions/browser/extension_prefs.h"\n',
                '#include "extensions/browser/extension_prefs.h"\n'
                '#include "extensions/buildflags/buildflags.h"\n'
                '#if BUILDFLAG(ENABLE_EXTENSIONS)\n'
                '#include "extensions/browser/extension_registry.h"\n'
                '#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"\n'
                '#endif\n',
            ),
            (
                'void ShowSettings(BrowserWindowInterface* browser) {\n'
                '  ShowSettingsSubPage(browser, std::string());\n',
                'void ShowSettings(BrowserWindowInterface* browser) {\n'
                '#if BUILDFLAG(ENABLE_EXTENSIONS)\n'
                '  auto* registry = extensions::ExtensionRegistry::Get(browser->GetProfile());\n'
                '  if (!browser->GetProfile()->IsOffTheRecord() && registry &&\n'
                '      registry->enabled_extensions().GetByID(breezer_workspace::kExtensionId)) {\n'
                '    FocusWebContents(browser);\n'
                '    ShowSingletonTab(browser,\n'
                '                     GURL("chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/"\n'
                '                          "workspace.html#/settings"));\n'
                '    return;\n'
                '  }\n'
                '#endif\n'
                '  ShowSettingsSubPage(browser, std::string());\n',
            ),
        ],
        "chrome/browser/ui/browser_ui_prefs.cc": [
            (
                '  registry->RegisterBooleanPref(prefs::kHeliumCenteredLocationBar, false);\n',
                '  registry->RegisterBooleanPref(prefs::kHeliumCenteredLocationBar, true);\n',
            ),
            (
                '  registry->RegisterBooleanPref(prefs::kHeliumMinimalLocationBar, false);\n',
                '  registry->RegisterBooleanPref(prefs::kHeliumMinimalLocationBar, true);\n',
            ),
        ],
        "chrome/browser/ui/helium/BUILD.gn": [
            (
                '    "helium_layout_state_controller.cc",\n'
                '    "helium_layout_state_controller.h",\n'
                '  ]\n',
                '    "breezer_workspace_prefs.h",\n'
                '    "helium_layout_state_controller.cc",\n'
                '    "helium_layout_state_controller.h",\n'
                '  ]\n',
            ),
            (
                '  deps = [\n'
                '    "//chrome/browser/ui/browser_window",\n'
                '    "//chrome/common:constants",\n'
                '  ]\n',
                '  deps = [\n'
                '    "//chrome/browser/profiles:profile",\n'
                '    "//chrome/browser/themes",\n'
                '    "//chrome/browser/ui/browser_window",\n'
                '    "//chrome/common:constants",\n'
                '    "//components/bookmarks/common",\n'
                '    "//ui/base/mojom",\n'
                '  ]\n',
            ),
        ],
        "chrome/browser/ui/tabs/tab_strip_prefs.cc": [
            (
                "  registry->RegisterBooleanPref(prefs::kHeliumZenMode, false);\n",
                "  registry->RegisterBooleanPref(prefs::kHeliumZenMode, true);\n",
            ),
            (
                '#include "chrome/browser/ui/helium/helium_layout_state_controller.h"\n',
                '#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"\n'
                '#include "chrome/browser/ui/helium/helium_layout_state_controller.h"\n',
            ),
            (
                "  registry->RegisterBooleanPref(prefs::kHeliumZenModeTopChromePinned, false);\n",
                "  registry->RegisterBooleanPref(prefs::kHeliumZenModeTopChromePinned, true);\n"
                "  registry->RegisterStringPref(breezer_workspace::prefs::kTheme,\n"
                "                               breezer_workspace::kDefaultTheme);\n"
                "  registry->RegisterBooleanPref(breezer_workspace::prefs::kInitialized,\n"
                "                                false);\n"
                '  registry->RegisterStringPref(breezer_workspace::prefs::kSidebarMode, "expanded");\n'
                '  registry->RegisterIntegerPref(breezer_workspace::prefs::kSidebarFontSize,\n'
                '                                breezer_workspace::kDefaultSidebarFontSize);\n'
                '  registry->RegisterIntegerPref(\n'
                '      breezer_workspace::prefs::kAppearanceDefaultsVersion, 0);\n',
            ),
        ],
        "chrome/browser/ui/BUILD.gn": [
            (
                '  if (enable_extensions) {\n'
                '    public_deps +=\n'
                '        [ "//chrome/browser/ui/views/extensions:extension_view_views" ]\n'
                '    deps += [\n',
                '  if (enable_extensions) {\n'
                '    sources += [\n'
                '      "views/frame/breezer_workspace_view.cc",\n'
                '      "views/frame/breezer_workspace_view.h",\n'
                '    ]\n'
                '    public_deps +=\n'
                '        [ "//chrome/browser/ui/views/extensions:extension_view_views" ]\n'
                '    deps += [\n',
            ),
        ],
        "chrome/common/extensions/api/api_sources.gni": [
            (
                '    "settings_private.idl",\n',
                '    "settings_private.idl",\n'
                '    "breezer_private.idl",\n',
            ),
        ],
        "chrome/common/extensions/api/_api_features.json": [
            (
                '  "search": {\n',
                '  "breezerPrivate": {\n'
                f'    "allowlist": ["{COMPONENT_ID_HASH}"],  // Breezer AI\n'
                '    "channel": "stable",\n'
                '    "contexts": ["privileged_extension"],\n'
                '    "extension_types": ["extension"],\n'
                '    "location": "component"\n'
                '  },\n'
                '  "search": {\n',
            ),
        ],
        "chrome/browser/extensions/api/BUILD.gn": [
            (
                '      "//chrome/browser/extensions/api/autofill_private",\n',
                '      "//chrome/browser/extensions/api/autofill_private",\n'
                '      "//chrome/browser/extensions/api/breezer_private",\n',
            ),
        ],
        **_peek_replacements(),
    })


def added_files():
    files = {}
    for source in sorted(path for path in NATIVE.rglob("*") if path.is_file()):
        relative = source.relative_to(NATIVE).as_posix()
        files[relative] = source
    if not files:
        raise ValueError("Native workspace overlay has no files")
    return files


def fingerprint():
    digest = hashlib.sha256()
    inputs = [ROOT / "script/apply_breezer_workspace.py",
              ROOT / "script/breezer_sidebar_frame.py"]
    inputs.extend(sorted(path for path in NATIVE.rglob("*") if path.is_file()))
    for path in inputs:
        name = path.relative_to(ROOT).as_posix()
        digest.update(name.encode() + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def _reject_symlinks(tree, name):
    path = tree / name
    current = path
    while True:
        if current.is_symlink():
            raise ValueError(f"Overlay target must not use symlinks: {name}")
        if current == tree or current.parent == current:
            return path
        current = current.parent


def source_file(tree, name):
    path = _reject_symlinks(tree, name)
    if not path.is_file():
        raise ValueError(f"Missing prepared source file: {name}")
    return path


def transform(name, content):
    text = content.decode("utf-8")
    for before, after in replacements()[name]:
        # A removal's shorter result can already occur inside its original.
        # Recognize the full original first, rather than skipping the removal.
        if after in before and text.count(before) == 1:
            text = text.replace(before, after, 1)
            continue
        if text.count(after) == 1:
            continue
        if text.count(before) != 1:
            raise ValueError(f"Native workspace anchor changed in {name}: {before[:100]!r}")
        text = text.replace(before, after, 1)
    for _, after in replacements()[name]:
        if text.count(after) != 1:
            raise ValueError(f"Native workspace change is not unique in {name}: {after[:100]!r}")
    return text.encode("utf-8")


def apply(tree, check=False):
    tree = Path(tree).resolve()
    if not tree.is_dir():
        raise ValueError(f"Source tree does not exist: {tree}")
    changes = replacements()

    # Validate every anchor and every added file before writing anything.
    originals = {name: source_file(tree, name).read_bytes() for name in changes}
    replacements_to_write = {}
    for name, original in originals.items():
        transformed = transform(name, original)
        if transformed != original:
            if check:
                raise ValueError(f"Native workspace overlay is missing from {name}")
            replacements_to_write[name] = transformed

    new_files_to_write = {}
    for relative, source in added_files().items():
        if relative in changes:
            raise ValueError(f"Added file collides with a patched file: {relative}")
        destination = _reject_symlinks(tree, relative)
        expected = source.read_bytes()
        if destination.is_file():
            if destination.read_bytes() != expected:
                raise ValueError(f"Native workspace file differs from overlay: {relative}")
        elif destination.exists():
            raise ValueError(f"Native workspace target is not a file: {relative}")
        elif check:
            raise ValueError(f"Native workspace file is missing: {relative}")
        else:
            new_files_to_write[relative] = expected

    for name, original in originals.items():
        if source_file(tree, name).read_bytes() != original:
            raise ValueError(f"Source changed during preparation: {name}")

    staged = {}
    try:
        for name, content in {**replacements_to_write, **new_files_to_write}.items():
            target = tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=target.parent, prefix=".breezer-workspace-", delete=False
            ) as output:
                temporary = Path(output.name)
                output.write(content)
            if target.exists():
                shutil.copymode(target, temporary)
            else:
                os.chmod(temporary, 0o644)
            staged[name] = temporary
        for name, temporary in staged.items():
            os.replace(temporary, tree / name)
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)
    return len(replacements_to_write) + len(new_files_to_write)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_tree", nargs="?", type=Path)
    parser.add_argument("--check", action="store_true", help="Verify without writing")
    parser.add_argument("--fingerprint", action="store_true")
    args = parser.parse_args()
    try:
        if args.fingerprint:
            if args.source_tree is not None or args.check:
                parser.error("--fingerprint does not take a source tree or --check")
            print(fingerprint())
            return
        if args.source_tree is None:
            parser.error("Provide the prepared Chromium source tree")
        changed = apply(args.source_tree, check=args.check)
        if args.check:
            print("Breezer workspace overlay verified.")
        else:
            print(f"Breezer workspace overlay applied; {changed} files updated.")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Cannot prepare Breezer workspace: {error}\n")


if __name__ == "__main__":
    main()
