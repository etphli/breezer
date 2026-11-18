// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#ifndef CHROME_BROWSER_UI_VIEWS_TABS_GROUPS_BREEZER_GROUP_COLOR_VIEW_H_
#define CHROME_BROWSER_UI_VIEWS_TABS_GROUPS_BREEZER_GROUP_COLOR_VIEW_H_

#include <array>
#include <cmath>
#include <memory>
#include <utility>

#include "base/memory/raw_ptr.h"

#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/strings/utf_string_conversions.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "ui/views/background.h"
#include "ui/views/controls/button/md_text_button.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/slider.h"
#include "ui/views/controls/textfield/textfield.h"
#include "ui/views/controls/textfield/textfield_controller.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/view.h"

// RGB sliders work with both pointer and keyboard; the hex field also accepts
// exact colours. Only Apply writes the profile, so exploratory edits are safe.
class BreezerGroupColorView : public views::View,
                              public views::SliderListener,
                              public views::TextfieldController {
  METADATA_HEADER(BreezerGroupColorView, views::View)

 public:
  BreezerGroupColorView(SkColor color,
                        base::RepeatingCallback<void(SkColor)> apply)
      : apply_(std::move(apply)) {
    SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kVertical, gfx::Insets::VH(8, 16), 6));
    auto* heading = AddChildView(std::make_unique<views::Label>(u"Custom colour"));
    heading->SetHorizontalAlignment(gfx::ALIGN_LEFT);
    const std::array<std::u16string, 3> names = {u"Red", u"Green", u"Blue"};
    const std::array<unsigned, 3> channels = {SkColorGetR(color), SkColorGetG(color), SkColorGetB(color)};
    for (size_t i = 0; i < sliders_.size(); ++i) {
      auto* row = AddChildView(std::make_unique<views::View>());
      auto* layout = row->SetLayoutManager(std::make_unique<views::BoxLayout>(
          views::BoxLayout::Orientation::kHorizontal, gfx::Insets(), 8));
      auto* label = row->AddChildView(std::make_unique<views::Label>(names[i]));
      label->SetPreferredSize(gfx::Size(42, 24));
      sliders_[i] = row->AddChildView(std::make_unique<views::Slider>(this));
      sliders_[i]->GetViewAccessibility().SetName(names[i]);
      sliders_[i]->SetValue(channels[i] / 255.0f);
      layout->SetFlexForView(sliders_[i], 1);
    }
    auto* row = AddChildView(std::make_unique<views::View>());
    row->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal, gfx::Insets(), 8));
    preview_ = row->AddChildView(std::make_unique<views::View>());
    preview_->SetPreferredSize(gfx::Size(28, 28));
    hex_ = row->AddChildView(std::make_unique<views::Textfield>());
    hex_->SetDefaultWidthInChars(8);
    hex_->GetViewAccessibility().SetName(u"Custom colour hex code");
    hex_->set_controller(this);
    hex_->SetTooltipText(u"Enter six hex digits, for example #3366CC");
    apply_button_ = row->AddChildView(std::make_unique<views::MdTextButton>(
        base::BindRepeating(&BreezerGroupColorView::Apply, base::Unretained(this)),
        u"Apply colour"));
    UpdatePreview();
  }

  void SliderValueChanged(views::Slider*, float, float,
                          views::SliderChangeReason) override {
    if (hex_ && !updating_) UpdatePreview();
  }

  void ContentsChanged(views::Textfield*, const std::u16string& text) override {
    std::string value = base::UTF16ToUTF8(text);
    if (value.starts_with('#')) value.erase(0, 1);
    uint32_t rgb = 0;
    const bool valid = value.size() == 6 &&
        value.find_first_not_of("0123456789abcdefABCDEF") == std::string::npos &&
        base::HexStringToUInt(value, &rgb);
    apply_button_->SetEnabled(valid);
    if (!valid) return;
    updating_ = true;
    sliders_[0]->SetValue(((rgb >> 16) & 255) / 255.0f);
    sliders_[1]->SetValue(((rgb >> 8) & 255) / 255.0f);
    sliders_[2]->SetValue((rgb & 255) / 255.0f);
    updating_ = false;
    preview_->SetBackground(views::CreateRoundedRectBackground(CurrentColor(), 4));
  }

 private:
  SkColor CurrentColor() const {
    const auto channel = [&](size_t i) {
      return static_cast<unsigned>(std::lround(sliders_[i]->GetValue() * 255));
    };
    return SkColorSetRGB(channel(0), channel(1), channel(2));
  }
  void UpdatePreview() {
    const SkColor color = CurrentColor();
    hex_->SetText(base::UTF8ToUTF16(base::StringPrintf("#%06X", color & 0xFFFFFF)));
    preview_->SetBackground(views::CreateRoundedRectBackground(color, 4));
    apply_button_->SetEnabled(true);
  }
  void Apply() { apply_.Run(CurrentColor()); }

  base::RepeatingCallback<void(SkColor)> apply_;
  std::array<raw_ptr<views::Slider>, 3> sliders_{};
  raw_ptr<views::Textfield> hex_ = nullptr;
  raw_ptr<views::View> preview_ = nullptr;
  raw_ptr<views::MdTextButton> apply_button_ = nullptr;
  bool updating_ = false;
};

#endif  // CHROME_BROWSER_UI_VIEWS_TABS_GROUPS_BREEZER_GROUP_COLOR_VIEW_H_
