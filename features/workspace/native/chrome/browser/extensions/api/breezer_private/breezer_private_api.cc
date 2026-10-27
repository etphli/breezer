// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#include "chrome/browser/extensions/api/breezer_private/breezer_private_api.h"

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/values.h"
#include "chrome/browser/extensions/window_controller.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"
#include "chrome/browser/ui/helium/helium_layout_state_controller.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/tabs/vertical_tab_strip_state_controller.h"
#include "chrome/common/pref_names.h"
#include "components/bookmarks/common/bookmark_pref_names.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_function_dispatcher.h"
#include "extensions/browser/permissions/active_tab_permission_granter.h"
#include "extensions/common/extension.h"
#include "extensions/common/mojom/api_permission_id.mojom-shared.h"
#include "extensions/common/permissions/permissions_data.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/mojom/themes.mojom.h"
#include "url/gurl.h"

namespace extensions {
namespace {

// Only the side panel document may ask for page access.
constexpr char kPanelPath[] = "/panel.html";

// Mirrors breezerPrivate.Appearance in breezer_private.idl.
struct Appearance {
  std::string layout;      // "sidebar" | "top"
  std::string theme;       // one of breezer_workspace::kThemes
  std::string color_mode;  // "system" | "light" | "dark"
  bool show_bookmarks = true;
  int sidebar_width = breezer_workspace::kDefaultSidebarWidth;
};

const breezer_workspace::Theme* FindTheme(std::string_view name) {
  for (const auto& theme : breezer_workspace::kThemes) {
    if (theme.name == name) {
      return &theme;
    }
  }
  return nullptr;
}

bool IsKnownAppearanceKey(std::string_view key) {
  return key == "layout" || key == "theme" || key == "colorMode" ||
         key == "showBookmarks" || key == "sidebarWidth";
}

bool IsUserModifiable(PrefService* prefs, std::string_view path) {
  const PrefService::Preference* const pref = prefs->FindPreference(path);
  return pref && pref->IsUserModifiable();
}

Appearance ReadAppearance(Profile* profile) {
  PrefService* const prefs = profile->GetPrefs();
  ThemeService* const theme_service =
      ThemeServiceFactory::GetForProfile(profile);
  Appearance result;
  result.layout = prefs->GetInteger(prefs::kHeliumLayout) ==
                          std::to_underlying(HeliumLayoutType::kVertical)
                      ? "sidebar"
                      : "top";

  // Report the theme the frame actually uses when it is one of Breezer's
  // seeds; otherwise keep the last Breezer choice so the contract stays fixed.
  result.theme = prefs->GetString(breezer_workspace::prefs::kTheme);
  if (!FindTheme(result.theme)) {
    result.theme = std::string(breezer_workspace::kDefaultTheme);
  }
  if (theme_service) {
    if (const std::optional<SkColor> color = theme_service->GetUserColor()) {
      for (const auto& theme : breezer_workspace::kThemes) {
        if (theme.seed == *color) {
          result.theme = std::string(theme.name);
          break;
        }
      }
    }
  }

  result.show_bookmarks = prefs->GetBoolean(bookmarks::prefs::kShowBookmarkBar);
  result.sidebar_width =
      std::clamp(prefs->GetInteger(prefs::kVerticalTabsUncollapsedWidth),
                 breezer_workspace::kMinSidebarWidth,
                 breezer_workspace::kMaxSidebarWidth);

  result.color_mode = "system";
  if (theme_service) {
    switch (theme_service->GetBrowserColorScheme()) {
      case ThemeService::BrowserColorScheme::kSystem:
        break;
      case ThemeService::BrowserColorScheme::kLight:
        result.color_mode = "light";
        break;
      case ThemeService::BrowserColorScheme::kDark:
        result.color_mode = "dark";
        break;
    }
  }
  return result;
}

base::Value::Dict AppearanceToValue(const Appearance& appearance) {
  base::Value::Dict result;
  result.Set("layout", appearance.layout);
  result.Set("theme", appearance.theme);
  result.Set("colorMode", appearance.color_mode);
  result.Set("showBookmarks", appearance.show_bookmarks);
  result.Set("sidebarWidth", appearance.sidebar_width);
  return result;
}

// Parses the whole patch into `appearance` without side effects. Any unknown
// key or invalid value rejects the patch.
bool ParseAppearancePatch(const base::Value::Dict& patch,
                          Appearance* appearance,
                          std::string* error) {
  if (patch.empty()) {
    *error = "Appearance change is empty.";
    return false;
  }
  for (const auto entry : patch) {
    if (!IsKnownAppearanceKey(entry.first)) {
      *error = "Unknown appearance setting: " + entry.first;
      return false;
    }
  }
  if (const base::Value* value = patch.Find("layout")) {
    const std::string* layout = value->GetIfString();
    if (!layout || (*layout != "sidebar" && *layout != "top")) {
      *error = "Invalid value for layout.";
      return false;
    }
    appearance->layout = *layout;
  }
  if (const base::Value* value = patch.Find("theme")) {
    const std::string* theme = value->GetIfString();
    if (!theme || !FindTheme(*theme)) {
      *error = "Invalid value for theme.";
      return false;
    }
    appearance->theme = *theme;
  }
  if (const base::Value* value = patch.Find("colorMode")) {
    const std::string* color_mode = value->GetIfString();
    if (!color_mode || (*color_mode != "system" && *color_mode != "light" &&
                        *color_mode != "dark")) {
      *error = "Invalid value for colorMode.";
      return false;
    }
    appearance->color_mode = *color_mode;
  }
  if (const base::Value* value = patch.Find("showBookmarks")) {
    if (!value->is_bool()) {
      *error = "Invalid value for showBookmarks.";
      return false;
    }
    appearance->show_bookmarks = value->GetBool();
  }
  if (const base::Value* value = patch.Find("sidebarWidth")) {
    if (!value->is_int() ||
        value->GetInt() < breezer_workspace::kMinSidebarWidth ||
        value->GetInt() > breezer_workspace::kMaxSidebarWidth) {
      *error = "Invalid value for sidebarWidth.";
      return false;
    }
    appearance->sidebar_width = value->GetInt();
  }
  return true;
}

// Rejects the patch before any write if a requested field is controlled by
// policy, an extension or another source the user cannot override.
bool CheckAppearanceWritable(Profile* profile,
                             const base::Value::Dict& patch,
                             std::string* error) {
  PrefService* const prefs = profile->GetPrefs();
  const bool changes_theme = patch.contains("theme");
  const bool changes_color_mode = patch.contains("colorMode");
  ThemeService* const theme_service =
      ThemeServiceFactory::GetForProfile(profile);
  if ((changes_theme || changes_color_mode) && !theme_service) {
    *error = "Browser appearance is unavailable.";
    return false;
  }
  if (patch.contains("layout") &&
      !IsUserModifiable(prefs, prefs::kHeliumLayout)) {
    *error = "The tab layout is managed by your organization.";
    return false;
  }
  if (patch.contains("showBookmarks") &&
      !IsUserModifiable(prefs, bookmarks::prefs::kShowBookmarkBar)) {
    *error = "The bookmarks bar is managed by your organization.";
    return false;
  }
  if (patch.contains("sidebarWidth") &&
      !IsUserModifiable(prefs, prefs::kVerticalTabsUncollapsedWidth)) {
    *error = "The sidebar width is managed by your organization.";
    return false;
  }
  if (changes_theme &&
      (theme_service->UsingPolicyTheme() ||
       !IsUserModifiable(prefs, prefs::kUserColor) ||
       !IsUserModifiable(prefs, breezer_workspace::prefs::kTheme))) {
    *error = "The browser theme is managed by your organization.";
    return false;
  }
  if (changes_color_mode &&
      !IsUserModifiable(prefs, prefs::kBrowserColorScheme)) {
    *error = "The browser appearance is managed by your organization.";
    return false;
  }
  return true;
}

ThemeService::BrowserColorScheme ColorSchemeFor(std::string_view color_mode) {
  if (color_mode == "light") {
    return ThemeService::BrowserColorScheme::kLight;
  }
  if (color_mode == "dark") {
    return ThemeService::BrowserColorScheme::kDark;
  }
  return ThemeService::BrowserColorScheme::kSystem;
}

// Writes only the fields present in `patch`. Width, layout and bookmark
// changes never touch the theme.
void ApplyAppearance(Profile* profile,
                     const Appearance& appearance,
                     const base::Value::Dict& patch) {
  PrefService* const prefs = profile->GetPrefs();
  if (patch.contains("layout")) {
    prefs->SetInteger(prefs::kHeliumLayout,
                      std::to_underlying(appearance.layout == "sidebar"
                                             ? HeliumLayoutType::kVertical
                                             : HeliumLayoutType::kClassic));
  }
  if (patch.contains("showBookmarks")) {
    prefs->SetBoolean(bookmarks::prefs::kShowBookmarkBar,
                      appearance.show_bookmarks);
  }
  if (patch.contains("theme")) {
    prefs->SetString(breezer_workspace::prefs::kTheme, appearance.theme);
    // An explicit Breezer theme choice replaces the current browser theme.
    ThemeServiceFactory::GetForProfile(profile)
        ->SetUserColorAndBrowserColorVariant(
            FindTheme(appearance.theme)->seed,
            ui::mojom::BrowserColorVariant::kTonalSpot);
  }
  if (patch.contains("colorMode")) {
    ThemeServiceFactory::GetForProfile(profile)->SetBrowserColorScheme(
        ColorSchemeFor(appearance.color_mode));
  }
  if (patch.contains("sidebarWidth")) {
    GlobalBrowserCollection::GetInstance()->ForEach(
        [&](BrowserWindowInterface* browser) {
          if (browser->GetProfile() == profile) {
            if (auto* const state_controller =
                    tabs::VerticalTabStripStateController::From(browser)) {
              state_controller->SetUncollapsedWidth(appearance.sidebar_width);
            }
          }
          return true;
        });
    // Also covers profiles with no open window.
    prefs->SetInteger(prefs::kVerticalTabsUncollapsedWidth,
                      appearance.sidebar_width);
  }
}

}  // namespace

BreezerPrivateFunction::BreezerPrivateFunction() = default;
BreezerPrivateFunction::~BreezerPrivateFunction() = default;

ExtensionFunction::ResponseAction BreezerPrivateFunction::Run() {
  if (!extension() || extension()->id() != breezer_workspace::kExtensionId) {
    return RespondNow(Error("This API is restricted to Breezer."));
  }
  if (!GetProfile() || GetProfile()->IsOffTheRecord()) {
    return RespondNow(Error("This API is unavailable in private windows."));
  }
  return RunFunction();
}

Profile* BreezerPrivateFunction::GetProfile() const {
  return Profile::FromBrowserContext(browser_context());
}

BrowserWindowInterface* BreezerPrivateFunction::GetCallerBrowser() const {
  if (!dispatcher()) {
    return nullptr;
  }
  // The window comes from the calling document's own host, never from
  // arguments.
  WindowController* const controller =
      dispatcher()->GetExtensionWindowController();
  BrowserWindowInterface* const browser =
      controller ? controller->GetBrowserWindowInterface() : nullptr;
  if (!browser || browser->GetProfile() != GetProfile()) {
    return nullptr;
  }
  return browser;
}

ExtensionFunction::ResponseAction
BreezerPrivateGetAppearanceFunction::RunFunction() {
  if (!args().empty()) {
    return RespondNow(Error("getAppearance does not accept arguments."));
  }
  return RespondNow(
      WithArguments(AppearanceToValue(ReadAppearance(GetProfile()))));
}

ExtensionFunction::ResponseAction
BreezerPrivateSetAppearanceFunction::RunFunction() {
  if (args().size() != 1 || !args()[0].is_dict()) {
    return RespondNow(Error("Appearance changes must be an object."));
  }
  const base::Value::Dict& patch = args()[0].GetDict();
  Appearance appearance = ReadAppearance(GetProfile());
  std::string error;
  if (!ParseAppearancePatch(patch, &appearance, &error) ||
      !CheckAppearanceWritable(GetProfile(), patch, &error)) {
    return RespondNow(Error(std::move(error)));
  }
  ApplyAppearance(GetProfile(), appearance, patch);
  // Report what the browser actually kept.
  return RespondNow(
      WithArguments(AppearanceToValue(ReadAppearance(GetProfile()))));
}

ExtensionFunction::ResponseAction
BreezerPrivateSetSidebarCollapsedFunction::RunFunction() {
  if (args().size() != 1 || !args()[0].is_bool()) {
    return RespondNow(Error("collapsed must be a boolean."));
  }
  BrowserWindowInterface* const browser = GetCallerBrowser();
  if (!browser) {
    return RespondNow(Error("Unable to resolve the calling browser window."));
  }
  auto* const state_controller =
      tabs::VerticalTabStripStateController::From(browser);
  if (!state_controller || !state_controller->ShouldDisplayVerticalTabs()) {
    return RespondNow(Error("The sidebar is unavailable in this window."));
  }
  state_controller->RequestCollapse(args()[0].GetBool());
  return RespondNow(NoArguments());
}

ExtensionFunction::ResponseAction
BreezerPrivateAuthorizeCurrentPageFunction::RunFunction() {
  if (!args().empty()) {
    return RespondNow(Error("authorizeCurrentPage does not accept arguments."));
  }
  if (!user_gesture()) {
    return RespondNow(Error("A user gesture is required."));
  }
  if (source_url().GetPath() != kPanelPath) {
    return RespondNow(Error("Page access can only be granted from Breezer AI."));
  }
  BrowserWindowInterface* const browser = GetCallerBrowser();
  if (!browser) {
    return RespondNow(Error("Unable to resolve the calling browser window."));
  }
  content::WebContents* const contents =
      browser->GetTabStripModel()->GetActiveWebContents();
  // activeTab only: one HTTP(S) page, until it navigates. No host permissions.
  if (!contents || !contents->GetLastCommittedURL().SchemeIsHTTPOrHTTPS() ||
      !extension()->permissions_data()->HasAPIPermission(
          mojom::APIPermissionID::kActiveTab)) {
    return RespondNow(WithArguments(false));
  }
  ActiveTabPermissionGranter* const granter =
      ActiveTabPermissionGranter::FromWebContents(contents);
  if (!granter) {
    return RespondNow(WithArguments(false));
  }
  granter->GrantIfRequested(extension());
  return RespondNow(WithArguments(true));
}

}  // namespace extensions
