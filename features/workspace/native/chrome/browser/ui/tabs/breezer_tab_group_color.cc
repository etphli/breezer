// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#include "chrome/browser/ui/tabs/breezer_tab_group_color.h"

#include <optional>
#include <string>

#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/tab_group_sync/tab_group_sync_service_factory.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/scoped_user_pref_update.h"
#include "components/saved_tab_groups/public/tab_group_sync_service.h"
#include "components/tab_groups/tab_group_id.h"
#include "third_party/skia/include/core/SkColor.h"

namespace breezer_tab_groups {

std::string SavedColorKey(Profile* profile,
                          const tab_groups::TabGroupId& group) {
  auto* service = tab_groups::TabGroupSyncServiceFactory::GetForProfile(profile);
  const auto saved = service ? service->GetGroup(group) : std::nullopt;
  return saved ? saved->saved_guid().AsLowercaseString() : std::string();
}

// Native palette IDs remain intact for Chromium and sync. RGB overrides belong
// to this profile, keyed by local identity and saved identity for reopen.
std::optional<SkColor> GetColor(Profile* profile,
                                 const tab_groups::TabGroupId& group) {
  const auto& colors = profile->GetPrefs()->GetDict(kColorsPref);
  auto rgb = colors.FindInt(group.ToString());
  if (!rgb) {
    const auto saved_key = SavedColorKey(profile, group);
    if (!saved_key.empty()) rgb = colors.FindInt(saved_key);
  }
  if (!rgb || *rgb < 0 || *rgb > 0xFFFFFF) return std::nullopt;
  return SkColorSetA(static_cast<SkColor>(*rgb), SK_AlphaOPAQUE);
}

void SetColor(Profile* profile,
              const tab_groups::TabGroupId& group,
              std::optional<SkColor> color) {
  const auto saved_key = SavedColorKey(profile, group);
  ScopedDictPrefUpdate update(profile->GetPrefs(), kColorsPref);
  const auto set = [&](const std::string& key) {
    if (color) update->Set(key, static_cast<int>(*color & 0xFFFFFF));
    else update->Remove(key);
  };
  set(group.ToString());
  if (!saved_key.empty()) set(saved_key);
}

// Session restore relabels local group IDs. Copy the RGB before visuals notify
// observers; retain the old key because closed-window restore may still use it.
void RestoreColor(Profile* profile,
                  const tab_groups::TabGroupId& old_group,
                  const tab_groups::TabGroupId& new_group) {
  const auto rgb = profile->GetPrefs()->GetDict(kColorsPref).FindInt(old_group.ToString());
  if (!rgb || *rgb < 0 || *rgb > 0xFFFFFF) return;
  ScopedDictPrefUpdate update(profile->GetPrefs(), kColorsPref);
  update->Set(new_group.ToString(), *rgb);
}

}  // namespace breezer_tab_groups
