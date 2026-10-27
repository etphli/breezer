// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#ifndef CHROME_BROWSER_UI_HELIUM_BREEZER_WORKSPACE_PREFS_H_
#define CHROME_BROWSER_UI_HELIUM_BREEZER_WORKSPACE_PREFS_H_

#include <cstdint>
#include <string_view>

namespace breezer_workspace {

inline constexpr char kExtensionId[] = "namgcidocfgliiedlkdafcmifpdfiakj";

inline constexpr int kDefaultSidebarWidth = 240;
inline constexpr int kMinSidebarWidth = 200;
inline constexpr int kMaxSidebarWidth = 360;

// The six Breezer themes and their native seed colors (ARGB, same layout as
// SkColor). The sidebar document uses the same names and base tones.
struct Theme {
  std::string_view name;
  uint32_t seed;
};
inline constexpr Theme kThemes[] = {
    {"mint", 0xFFDDF2EB},   {"tide", 0xFFDCE8F6},   {"dusk", 0xFFE7E0F3},
    {"rose", 0xFFF5DFE3},   {"pollen", 0xFFECEFC9}, {"graphite", 0xFFE4E6E9},
};
inline constexpr std::string_view kDefaultTheme = "mint";

namespace prefs {

// Last Breezer theme the user picked. Reported when the browser color does
// not match one of kThemes exactly.
inline constexpr char kTheme[] = "breezer.workspace.theme";
// Set once the one-time layout, bookmarks bar, width and theme defaults have
// been applied to a profile. Later user choices are never overwritten.
inline constexpr char kInitialized[] = "breezer.workspace.initialized";

}  // namespace prefs
}  // namespace breezer_workspace

#endif  // CHROME_BROWSER_UI_HELIUM_BREEZER_WORKSPACE_PREFS_H_
