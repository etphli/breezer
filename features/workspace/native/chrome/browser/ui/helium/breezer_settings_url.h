// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#ifndef CHROME_BROWSER_UI_HELIUM_BREEZER_SETTINGS_URL_H_
#define CHROME_BROWSER_UI_HELIUM_BREEZER_SETTINGS_URL_H_

#include <string_view>

#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"
#include "url/gurl.h"

namespace breezer_workspace {

inline constexpr char16_t kSettingsAddressLabel[] = u"Breezer Settings";

inline bool IsSettingsURL(const GURL& url) {
  if (!url.is_valid() || !url.SchemeIs("chrome-extension") ||
      url.host() != kExtensionId || url.path() != "/workspace.html") {
    return false;
  }

  std::string_view route = url.ref();
  if (route.starts_with('/')) {
    route.remove_prefix(1);
  }
  route = route.substr(0, route.find('?'));
  return route == "settings" || route.starts_with("settings/");
}

}  // namespace breezer_workspace

#endif  // CHROME_BROWSER_UI_HELIUM_BREEZER_SETTINGS_URL_H_
