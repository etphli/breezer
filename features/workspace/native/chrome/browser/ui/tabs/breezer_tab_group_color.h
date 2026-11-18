// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#ifndef CHROME_BROWSER_UI_TABS_BREEZER_TAB_GROUP_COLOR_H_
#define CHROME_BROWSER_UI_TABS_BREEZER_TAB_GROUP_COLOR_H_

#include <optional>

#include "components/tab_groups/tab_group_id.h"
#include "third_party/skia/include/core/SkColor.h"

class Profile;

namespace breezer_tab_groups {

inline constexpr char kColorsPref[] = "breezer.workspace.tab_group_colors";

std::optional<SkColor> GetColor(Profile* profile, const tab_groups::TabGroupId& group);
void SetColor(Profile* profile, const tab_groups::TabGroupId& group,
              std::optional<SkColor> color);
void RestoreColor(Profile* profile, const tab_groups::TabGroupId& old_group,
                  const tab_groups::TabGroupId& new_group);

}  // namespace breezer_tab_groups

#endif  // CHROME_BROWSER_UI_TABS_BREEZER_TAB_GROUP_COLOR_H_
