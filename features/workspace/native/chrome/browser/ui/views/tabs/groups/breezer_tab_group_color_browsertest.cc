// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#include "chrome/browser/ui/tabs/breezer_tab_group_color.h"

#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/test/base/in_process_browser_test.h"
#include "content/public/test/browser_test.h"
#include "testing/gtest/include/gtest/gtest.h"

using BreezerTabGroupColorBrowserTest = InProcessBrowserTest;

IN_PROC_BROWSER_TEST_F(BreezerTabGroupColorBrowserTest, ExactRgbAndStockReset) {
  auto* profile = browser()->GetProfile();
  const auto group = browser()->GetTabStripModel()->AddToNewGroup({0});
  EXPECT_FALSE(breezer_tab_groups::GetColor(profile, group));
  for (SkColor color : {SK_ColorBLACK, SkColorSetRGB(18, 171, 239), SK_ColorWHITE}) {
    breezer_tab_groups::SetColor(profile, group, color);
    EXPECT_EQ(color, breezer_tab_groups::GetColor(profile, group));
  }
  breezer_tab_groups::SetColor(profile, group, std::nullopt);
  EXPECT_FALSE(breezer_tab_groups::GetColor(profile, group));
}

IN_PROC_BROWSER_TEST_F(BreezerTabGroupColorBrowserTest, RelabeledSessionIdentity) {
  auto* profile = browser()->GetProfile();
  const auto group = browser()->GetTabStripModel()->AddToNewGroup({0});
  const auto restored = tab_groups::TabGroupId::GenerateNew();
  const SkColor color = SkColorSetRGB(237, 91, 163);
  breezer_tab_groups::SetColor(profile, group, color);
  breezer_tab_groups::RestoreColor(profile, group, restored);
  EXPECT_EQ(color, breezer_tab_groups::GetColor(profile, restored));
  EXPECT_FALSE(breezer_tab_groups::GetColor(profile, tab_groups::TabGroupId::GenerateNew()));
}
