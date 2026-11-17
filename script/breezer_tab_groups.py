"""Native tab-group usability anchors for the pinned Chromium source."""

EDITOR = 'chrome/browser/ui/views/tabs/groups/tab_group_editor_bubble_view.cc'
REGION = 'chrome/browser/ui/views/frame/horizontal_tab_strip_region_view.cc'
REGION_HEADER = 'chrome/browser/ui/views/frame/horizontal_tab_strip_region_view.h'
COLOR_HEADER = 'chrome/browser/ui/tabs/breezer_tab_group_color.h'


def replacements():
    color_include = f'#include "{COLOR_HEADER}"\n'
    button = '''  if (browser && browser->GetType() == BrowserWindowInterface::Type::TYPE_NORMAL &&
      browser->GetTabStripModel()->SupportsTabGroups()) {
    new_group_button_ = AddChildView(std::make_unique<views::MdTextButton>(
        base::BindRepeating(&chrome::CreateNewTabGroup, base::Unretained(browser)),
        u"New group"));
    new_group_button_->SetTooltipText(u"Create a new tab group");
    new_group_button_->SetProperty(views::kCrossAxisAlignmentKey,
                                  views::LayoutAlignment::kCenter);
  }

'''
    region = [
        ('#include "ui/views/border.h"\n', '#include "ui/views/border.h"\n#include "ui/views/controls/button/md_text_button.h"\n'),
        ('  if (base::FeatureList::IsEnabled(features::kTabGroupsFocusing)) {\n', button + '  if (base::FeatureList::IsEnabled(features::kTabGroupsFocusing)) {\n'),
        ('  if (browser && ShouldShowNewTabButton(browser)) {\n', button + '  if (browser && ShouldShowNewTabButton(browser)) {\n'),
    ]
    for kind in ('Old', 'New'):
        caption = f'''bool HorizontalTabStripRegionView{kind}::IsPositionInWindowCaption(
    const gfx::Point& point) {{
'''
        region.append((caption, caption + '''  if (new_group_button_ && IsHitInView(new_group_button_, point)) {
    return false;
  }
'''))
        order = f'''views::View::Views HorizontalTabStripRegionView{kind}::GetChildrenInZOrder() {{
  views::View::Views children;
'''
        region.append((order, order + '''  if (new_group_button_) children.emplace_back(new_group_button_.get());
'''))
    return {
        REGION: region,
        REGION_HEADER: [
            ('  raw_ptr<TabStripControlButton> unfocus_button_ = nullptr;\n',
             '  raw_ptr<views::Button> new_group_button_ = nullptr;\n  raw_ptr<TabStripControlButton> unfocus_button_ = nullptr;\n'),
            ('  raw_ptr<views::Button> new_tab_button_ = nullptr;\n\n  std::unique_ptr<views::ActionViewController> action_view_controller_;\n',
             '  raw_ptr<views::Button> new_tab_button_ = nullptr;\n  raw_ptr<views::Button> new_group_button_ = nullptr;\n\n  std::unique_ptr<views::ActionViewController> action_view_controller_;\n'),
        ],
        EDITOR: [
            ('#include "chrome/browser/ui/views/tabs/groups/color_picker_view.h"\n',
             color_include + '#include "chrome/browser/ui/views/tabs/groups/breezer_group_color_view.h"\n#include "chrome/browser/ui/views/tabs/groups/color_picker_view.h"\n'),
            ('  color_selector_ = AddChildView(BuildColorPicker());\n', '''  color_selector_ = AddChildView(BuildColorPicker());
  if (!IsEphemeralTabGroup() && OwnsGroup()) {
    AddChildView(std::make_unique<BreezerGroupColorView>(
        breezer_tab_groups::GetColor(browser_->GetProfile(), group_)
            .value_or(SkColorSetRGB(67, 97, 238)),
        base::BindRepeating(
            [](TabGroupEditorBubbleView* self, SkColor color) {
              breezer_tab_groups::SetColor(self->browser_->GetProfile(), self->group_, color);
              self->UpdateGroup();
              const auto index = self->GetIndexOf(self->color_selector_).value();
              self->RemoveChildViewT<ColorPickerView>(self->color_selector_);
              self->color_selector_ = self->AddChildViewAt(self->BuildColorPicker(), index);
            }, base::Unretained(this))));
  }
'''),
            ('''          this, colors_, initial_color_id,
          base::BindRepeating(&TabGroupEditorBubbleView::UpdateGroup,
                              base::Unretained(this)));
''', '''          this, colors_,
          breezer_tab_groups::GetColor(browser_->GetProfile(), group_)
              ? static_cast<tab_groups::TabGroupColorId>(-1) : initial_color_id,
          base::BindRepeating(
              [](TabGroupEditorBubbleView* self) {
                breezer_tab_groups::SetColor(self->browser_->GetProfile(), self->group_, std::nullopt);
                self->UpdateGroup();
              }, base::Unretained(this)));
'''),
        ],
        'chrome/browser/ui/tabs/BUILD.gn': [
            ('  source_set("tab_group") {\n', '''  source_set("breezer_group_colors") {
    sources = [ "breezer_tab_group_color.cc", "breezer_tab_group_color.h" ]
    public_deps = [ "//components/tab_groups", "//skia" ]
    deps = [
      "//base",
      "//chrome/browser/profiles:profile",
      "//chrome/browser/tab_group_sync:factories",
      "//components/prefs",
      "//components/saved_tab_groups/public",
    ]
  }

  source_set("tab_group") {
'''),
        ],
        'chrome/browser/ui/views/tabs/BUILD.gn': [
            ('    "tab_group_views.cc",\n  ]\n\n  deps = [\n',
             '    "tab_group_views.cc",\n  ]\n\n  deps = [\n    "//chrome/browser/ui/tabs:breezer_group_colors",\n'),
            ('  sources = [ "tab.cc" ]\n\n  deps = [\n',
             '  sources = [ "tab.cc" ]\n\n  deps = [\n    "//chrome/browser/ui/tabs:breezer_group_colors",\n'),
        ],
        'chrome/browser/ui/views/tabs/groups/BUILD.gn': [
            ('    "tab_group_editor_bubble_view.cc",\n  ]\n\n  deps = [\n',
             '    "tab_group_editor_bubble_view.cc",\n    "breezer_group_color_view.cc",\n    "breezer_group_color_view.h",\n  ]\n\n  deps = [\n    "//chrome/browser/ui/tabs:breezer_group_colors",\n'),
            ('    "tab_group_editor_bubble_view_browsertest.cc",\n  ]\n  deps = [\n',
             '    "tab_group_editor_bubble_view_browsertest.cc",\n    "breezer_tab_group_color_browsertest.cc",\n  ]\n  deps = [\n    "//chrome/browser/ui/tabs:breezer_group_colors",\n'),
        ],
        'chrome/browser/sessions/BUILD.gn': [
            ('      "//chrome/browser/ui:browser_init_state",\n      "//chrome/browser/ui:browser_manager_service",\n',
             '      "//chrome/browser/ui/tabs:breezer_group_colors",\n      "//chrome/browser/ui:browser_init_state",\n      "//chrome/browser/ui:browser_manager_service",\n'),
        ],
        'chrome/browser/ui/views/tabs/tab.cc': [
            ('#include "chrome/browser/ui/views/tabs/tab.h"\n',
             '#include "chrome/browser/ui/views/tabs/tab.h"\n' + color_include),
            ('''  return controller_->GetPaintedGroupColor(
      controller_->GetGroupColorId(group().value()));
''', '''  const SkColor stock_color = controller_->GetPaintedGroupColor(
      controller_->GetGroupColorId(group().value()));
  auto* browser = controller_->GetBrowserWindowInterface();
  return browser ? breezer_tab_groups::GetColor(browser->GetProfile(), group().value())
                       .value_or(stock_color)
                 : stock_color;
'''),
        ],
        'chrome/browser/ui/views/tabs/tab_group_header.cc': [
            ('#include "chrome/browser/ui/views/tabs/groups/tab_group_accessibility.h"\n', color_include + '#include "chrome/browser/ui/views/tabs/groups/tab_group_accessibility.h"\n'),
            ('''  should_show_header_icon_ = ShouldShowHeaderIcon();
''', '''  if (auto* browser = tab_slot_controller_->GetBrowserWindowInterface()) {
    color_ = breezer_tab_groups::GetColor(browser->GetProfile(), tab_group_id)
                 .value_or(color_);
  }
  should_show_header_icon_ = ShouldShowHeaderIcon();
'''),
        ],
        'chrome/browser/ui/views/tabs/tab_group_views.cc': [
            ('#include "chrome/browser/ui/views/tabs/tab_group_views.h"\n', '#include "chrome/browser/ui/views/tabs/tab_group_views.h"\n' + color_include + '#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"\n'),
            ('''  return tab_slot_controller_->GetPaintedGroupColor(
      tab_slot_controller_->GetGroupColorId(group_));
''', '''  const SkColor stock_color = tab_slot_controller_->GetPaintedGroupColor(
      tab_slot_controller_->GetGroupColorId(group_));
  auto* browser = tab_slot_controller_->GetBrowserWindowInterface();
  return browser ? breezer_tab_groups::GetColor(browser->GetProfile(), group_)
                       .value_or(stock_color)
                 : stock_color;
'''),
        ],
        'chrome/browser/sessions/session_restore.cc': [
            ('#include "chrome/browser/sessions/session_restore.h"\n', '#include "chrome/browser/sessions/session_restore.h"\n' + color_include),
            ('''      CHECK(model_tab_group);
      browser->GetTabStripModel()->ChangeTabGroupVisuals(
''', '''      CHECK(model_tab_group);
      breezer_tab_groups::RestoreColor(browser->GetProfile(), session_tab_group->id,
                                       new_tab_group_id);
      browser->GetTabStripModel()->ChangeTabGroupVisuals(
'''),
        ],
    }
