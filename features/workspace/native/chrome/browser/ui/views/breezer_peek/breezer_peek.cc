// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#include "chrome/browser/ui/views/breezer_peek/breezer_peek.h"

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "base/auto_reset.h"
#include "base/callback_list.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/location.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/raw_ref.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_multi_source_observation.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "components/input/native_web_keyboard_event.h"
#include "components/tabs/public/tab_interface.h"
#include "components/url_formatter/url_formatter.h"
#include "components/vector_icons/vector_icons.h"
#include "content/public/browser/invalidate_type.h"
#include "content/public/browser/keyboard_event_processing_result.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_user_data.h"
#include "net/base/registry_controlled_domains/registry_controlled_domain.h"
#include "third_party/blink/public/mojom/window_features/window_features.mojom.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/accessibility/ax_enums.mojom.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/ui_base_types.h"
#include "ui/color/color_id.h"
#include "ui/events/event.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/gfx/text_constants.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "ui/views/background.h"
#include "ui/views/controls/button/image_button.h"
#include "ui/views/controls/button/image_button_factory.h"
#include "ui/views/controls/button/md_text_button.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/native/native_view_host.h"
#include "ui/views/controls/webview/unhandled_keyboard_event_handler.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_observer.h"
#include "url/gurl.h"

namespace breezer_peek {

namespace {

constexpr int kMargin = 32;
constexpr int kMaxCardSide = 920;
constexpr int kMinCardSide = 280;
constexpr int kToolbarHeight = 44;
constexpr float kCardRadius = 12;
constexpr SkColor kScrimColor = SkColorSetA(SK_ColorBLACK, 0x66);

bool IsEscape(const input::NativeWebKeyboardEvent& event) {
  return event.GetType() == input::NativeWebKeyboardEvent::Type::kRawKeyDown &&
         event.windows_key_code == ui::VKEY_ESCAPE;
}

// The card: centred, roughly square, never taller or wider than the window
// allows.
gfx::Rect CardBounds(const gfx::Rect& area) {
  const int max_width = std::max(0, area.width() - 2 * kMargin);
  const int max_height = std::max(0, area.height() - 2 * kMargin);
  int height = std::min(max_height, kMaxCardSide);
  const int width = std::min(max_width, height * 21 / 20);
  height = std::min(height, std::max(width, kMinCardSide) * 21 / 20);
  gfx::Rect card(width, height);
  card.set_x(area.x() + (area.width() - width) / 2);
  card.set_y(area.y() + (area.height() - height) / 2);
  return card;
}

class Peek;

// Lives on a tab's WebContents: whether the tab is a favourite's live tab,
// and the peek it currently shows. Destroying the tab destroys its peek.
class PeekSource : public content::WebContentsUserData<PeekSource> {
 public:
  PeekSource(const PeekSource&) = delete;
  PeekSource& operator=(const PeekSource&) = delete;
  ~PeekSource() override;

  bool enabled() const { return enabled_; }
  void set_enabled(bool enabled) { enabled_ = enabled; }

  // True while a request made from this tab's peek, or Expand, is passed to
  // the browser. Peek interception is off for that call.
  bool forwarding() const { return forwarding_; }
  base::AutoReset<bool> Forward() { return base::AutoReset<bool>(&forwarding_, true); }

  // Shows `contents` in a new peek over `browser_widget`, replacing any peek
  // this tab already shows.
  content::WebContents* Show(std::unique_ptr<content::WebContents> contents,
                             views::Widget& browser_widget);
  // Hides `peek` now and destroys it in a later task, so it is safe to call
  // from inside the peek's own WebContents or widget callbacks.
  void DismissSoon(Peek* peek);

 private:
  friend class content::WebContentsUserData<PeekSource>;
  explicit PeekSource(content::WebContents& contents);

  bool enabled_ = false;
  bool forwarding_ = false;
  std::unique_ptr<Peek> peek_;

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

// The scrim that covers the browser window, with the card on top of it.
class PeekRootView : public views::View {
 public:
  explicit PeekRootView(base::RepeatingClosure dismiss)
      : dismiss_(std::move(dismiss)) {
    SetBackground(views::CreateSolidBackground(kScrimColor));
    AddAccelerator(ui::Accelerator(ui::VKEY_ESCAPE, ui::EF_NONE));
    GetViewAccessibility().SetRole(ax::mojom::Role::kDialog);
    GetViewAccessibility().SetName(std::u16string(u"Peek"));
  }

  void SetCard(views::View* card) {
    card_ = card;
    card_->SetBoundsRect(CardBounds(GetLocalBounds()));
  }

  // views::View:
  void OnBoundsChanged(const gfx::Rect& previous_bounds) override {
    if (card_) {
      card_->SetBoundsRect(CardBounds(GetLocalBounds()));
    }
  }
  bool OnMousePressed(const ui::MouseEvent& event) override {
    // Presses on the card's own controls never reach here; presses on the
    // backdrop around it close the peek.
    if (!card_ || !card_->bounds().Contains(event.location())) {
      dismiss_.Run();
    }
    return true;
  }
  bool AcceleratorPressed(const ui::Accelerator& accelerator) override {
    dismiss_.Run();
    return true;
  }

 private:
  base::RepeatingClosure dismiss_;
  raw_ptr<views::View> card_ = nullptr;
};

class Peek final : public content::WebContentsDelegate,
                   public views::WidgetObserver {
 public:
  Peek(PeekSource& owner,
       content::WebContents& source,
       std::unique_ptr<content::WebContents> contents,
       views::Widget& browser_widget)
      : owner_(owner), source_(source), contents_(std::move(contents)) {
    contents_->SetDelegate(this);

    widget_ = std::make_unique<views::Widget>();
    views::Widget::InitParams params(
        views::Widget::InitParams::CLIENT_OWNS_WIDGET,
        views::Widget::InitParams::TYPE_WINDOW_FRAMELESS);
    params.SetParent(&browser_widget);
    params.opacity = views::Widget::InitParams::WindowOpacity::kTranslucent;
    params.activatable = views::Widget::InitParams::Activatable::kYes;
    params.shadow_type = views::Widget::InitParams::ShadowType::kNone;
    params.bounds = browser_widget.GetClientAreaBoundsInScreen();
    params.name = "BreezerPeek";
    widget_->Init(std::move(params));

    auto* const root = widget_->SetContentsView(
        std::make_unique<PeekRootView>(base::BindRepeating(
            &Peek::Dismiss, weak_factory_.GetWeakPtr())));
    auto* const card = root->AddChildView(std::make_unique<views::View>());
    root->SetCard(card);
    card->SetBackground(views::CreateRoundedRectBackground(
        ui::kColorDialogBackground, kCardRadius));
    auto* const card_layout =
        card->SetLayoutManager(std::make_unique<views::BoxLayout>(
            views::BoxLayout::Orientation::kVertical));

    // Toolbar: what is loading, then Expand and Close at the top right.
    auto* const toolbar = card->AddChildView(std::make_unique<views::View>());
    toolbar->SetPreferredSize(gfx::Size(0, kToolbarHeight));
    auto* const toolbar_layout =
        toolbar->SetLayoutManager(std::make_unique<views::BoxLayout>(
            views::BoxLayout::Orientation::kHorizontal,
            gfx::Insets::TLBR(0, 16, 0, 8), 6));
    toolbar_layout->set_cross_axis_alignment(
        views::BoxLayout::CrossAxisAlignment::kCenter);

    title_ = toolbar->AddChildView(std::make_unique<views::Label>());
    title_->SetHorizontalAlignment(gfx::ALIGN_LEFT);
    title_->SetElideBehavior(gfx::ELIDE_TAIL);
    origin_ = toolbar->AddChildView(std::make_unique<views::Label>());
    origin_->SetHorizontalAlignment(gfx::ALIGN_LEFT);
    origin_->SetElideBehavior(gfx::ELIDE_HEAD);
    origin_->SetEnabledColor(ui::kColorLabelForegroundSecondary);
    toolbar_layout->SetFlexForView(title_, 2);
    toolbar_layout->SetFlexForView(origin_, 1);

    auto* const expand = toolbar->AddChildView(
        std::make_unique<views::MdTextButton>(
            base::BindRepeating(&Peek::Expand, weak_factory_.GetWeakPtr()),
            u"Expand"));
    expand->SetStyle(ui::ButtonStyle::kTonal);
    expand->SetTooltipText(u"Open as a tab");

    auto close = views::CreateVectorImageButtonWithNativeTheme(
        base::BindRepeating(&Peek::Dismiss, weak_factory_.GetWeakPtr()),
        vector_icons::kCloseIcon, 16);
    close->SetTooltipText(u"Close peek");
    close->SetAccessibleName(u"Close peek");
    toolbar->AddChildView(std::move(close));

    web_view_ = card->AddChildView(
        std::make_unique<views::WebView>(contents_->GetBrowserContext()));
    web_view_->SetWebContents(contents_.get());
    web_view_->holder()->SetNativeViewCornerRadii(
        gfx::RoundedCornersF(0, 0, kCardRadius, kCardRadius));
    card_layout->SetFlexForView(web_view_, 1);
    UpdateTitle();

    // Close when the favourite tab stops being the visible tab or leaves.
    if (tabs::TabInterface* const tab =
            tabs::TabInterface::MaybeGetFromContents(&source)) {
      tab_subscriptions_.push_back(tab->RegisterWillDeactivate(
          base::BindRepeating(&Peek::OnTabChanged, base::Unretained(this))));
      tab_subscriptions_.push_back(tab->RegisterWillDetach(base::BindRepeating(
          [](Peek* peek, tabs::TabInterface* tab,
             tabs::TabInterface::DetachReason) { peek->OnTabChanged(tab); },
          base::Unretained(this))));
    }
    widget_observations_.AddObservation(&browser_widget);
    widget_observations_.AddObservation(widget_.get());

    widget_->Show();
    web_view_->RequestFocus();
  }

  Peek(const Peek&) = delete;
  Peek& operator=(const Peek&) = delete;

  ~Peek() override {
    widget_observations_.RemoveAllObservations();
    tab_subscriptions_.clear();
    if (web_view_) {
      web_view_->SetWebContents(nullptr);
    }
    web_view_ = nullptr;
    title_ = nullptr;
    origin_ = nullptr;
    widget_.reset();
    if (contents_) {
      contents_->SetDelegate(nullptr);
    }
    // `contents_` is destroyed last, after nothing displays it.
  }

  // Called once the peek is dismissed and waiting to be destroyed. After
  // this nothing (tab, windows, buttons or the page) can call back into the
  // peek, so its owner and source tab may go away first.
  void Detach() {
    weak_factory_.InvalidateWeakPtrs();
    widget_observations_.RemoveAllObservations();
    tab_subscriptions_.clear();
    if (contents_) {
      contents_->SetDelegate(nullptr);
    }
    if (widget_) {
      widget_->Hide();
    }
  }

  // content::WebContentsDelegate:
  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)>
          navigation_handle_callback) override {
    if (params.disposition == WindowOpenDisposition::CURRENT_TAB) {
      base::WeakPtr<content::NavigationHandle> handle =
          contents_->GetController().LoadURLWithParams(
              content::NavigationController::LoadURLParams(params));
      if (handle && navigation_handle_callback) {
        std::move(navigation_handle_callback).Run(*handle);
      }
      return contents_.get();
    }
    // Everything else opens as the browser would from the favourite's tab.
    content::WebContentsDelegate* const delegate = source_->GetDelegate();
    if (!delegate) {
      return nullptr;
    }
    auto forwarding = owner_->Forward();
    return delegate->OpenURLFromTab(&*source_, params,
                                    std::move(navigation_handle_callback));
  }

  content::WebContents* AddNewContents(
      content::WebContents* source,
      std::unique_ptr<content::WebContents> new_contents,
      const GURL& target_url,
      WindowOpenDisposition disposition,
      const blink::mojom::WindowFeatures& window_features,
      bool user_gesture,
      bool* was_blocked) override {
    content::WebContentsDelegate* const delegate = source_->GetDelegate();
    if (!delegate) {
      return nullptr;
    }
    auto forwarding = owner_->Forward();
    return delegate->AddNewContents(&*source_, std::move(new_contents),
                                    target_url, disposition, window_features,
                                    user_gesture, was_blocked);
  }

  void CloseContents(content::WebContents* source) override { Dismiss(); }

  void NavigationStateChanged(content::WebContents* source,
                              content::InvalidateTypes changed_flags) override {
    if (changed_flags &
        (content::INVALIDATE_TYPE_URL | content::INVALIDATE_TYPE_TITLE)) {
      UpdateTitle();
    }
  }

  content::KeyboardEventProcessingResult PreHandleKeyboardEvent(
      content::WebContents* source,
      const input::NativeWebKeyboardEvent& event) override {
    // Handled before the page sees it, so a focused page cannot keep the
    // peek open by swallowing Escape.
    if (IsEscape(event)) {
      Dismiss();
      return content::KeyboardEventProcessingResult::HANDLED;
    }
    return content::KeyboardEventProcessingResult::NOT_HANDLED;
  }

  bool HandleKeyboardEvent(
      content::WebContents* source,
      const input::NativeWebKeyboardEvent& event) override {
    return widget_ && unhandled_keyboard_event_handler_.HandleKeyboardEvent(
                          event, widget_->GetFocusManager());
  }

  // views::WidgetObserver:
  void OnWidgetBoundsChanged(views::Widget* widget,
                             const gfx::Rect& new_bounds) override {
    if (widget != widget_.get() && widget_) {
      widget_->SetBounds(widget->GetClientAreaBoundsInScreen());
    }
  }

  void OnWidgetActivationChanged(views::Widget* widget, bool active) override {
    if (widget == widget_.get()) {
      was_active_ |= active;
    } else if (active && was_active_) {
      // The browser window took focus back from the peek.
      Dismiss();
    }
  }

  void OnWidgetDestroying(views::Widget* widget) override {
    widget_observations_.RemoveObservation(widget);
    Dismiss();
  }

 private:
  void Dismiss() { owner_->DismissSoon(this); }

  void OnTabChanged(tabs::TabInterface* tab) { Dismiss(); }

  // Moves the same live WebContents into an ordinary tab: no reload, so page
  // state, form input and history stay as they are.
  void Expand() {
    content::WebContentsDelegate* const delegate = source_->GetDelegate();
    if (!contents_ || !delegate) {
      Dismiss();
      return;
    }
    const GURL url = contents_->GetVisibleURL();
    web_view_->SetWebContents(nullptr);
    contents_->SetDelegate(nullptr);
    std::unique_ptr<content::WebContents> contents = std::move(contents_);
    PeekSource& owner = *owner_;
    content::WebContents& source = *source_;
    // Destroys this peek in a later task; only locals are used below.
    Dismiss();
    auto forwarding = owner.Forward();
    delegate->AddNewContents(&source, std::move(contents), url,
                             WindowOpenDisposition::NEW_FOREGROUND_TAB,
                             blink::mojom::WindowFeatures(),
                             /*user_gesture=*/true, nullptr);
  }

  void UpdateTitle() {
    if (!title_ || !contents_) {
      return;
    }
    const GURL& url = contents_->GetVisibleURL();
    const std::u16string origin = url_formatter::FormatUrlForSecurityDisplay(
        url, url_formatter::SchemeDisplay::OMIT_HTTP_AND_HTTPS);
    const std::u16string title = contents_->GetTitle();
    title_->SetText(title.empty() ? origin : title);
    origin_->SetText(origin);
    title_->SetTooltipText(title);
    origin_->SetTooltipText(base::UTF8ToUTF16(url.possibly_invalid_spec()));
  }

  const raw_ref<PeekSource> owner_;
  const raw_ref<content::WebContents> source_;
  std::unique_ptr<content::WebContents> contents_;
  std::unique_ptr<views::Widget> widget_;
  raw_ptr<views::WebView> web_view_ = nullptr;
  raw_ptr<views::Label> title_ = nullptr;
  raw_ptr<views::Label> origin_ = nullptr;
  views::UnhandledKeyboardEventHandler unhandled_keyboard_event_handler_;
  std::vector<base::CallbackListSubscription> tab_subscriptions_;
  base::ScopedMultiSourceObservation<views::Widget, views::WidgetObserver>
      widget_observations_{this};
  bool was_active_ = false;
  base::WeakPtrFactory<Peek> weak_factory_{this};
};

PeekSource::PeekSource(content::WebContents& contents)
    : content::WebContentsUserData<PeekSource>(contents) {}

PeekSource::~PeekSource() = default;

content::WebContents* PeekSource::Show(
    std::unique_ptr<content::WebContents> contents,
    views::Widget& browser_widget) {
  if (peek_) {
    DismissSoon(peek_.get());
  }
  content::WebContents* const shown = contents.get();
  peek_ = std::make_unique<Peek>(*this, GetWebContents(), std::move(contents),
                                 browser_widget);
  return shown;
}

void PeekSource::DismissSoon(Peek* peek) {
  if (!peek || peek_.get() != peek) {
    return;
  }
  peek_->Detach();
  base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(
      FROM_HERE, std::move(peek_));
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(PeekSource);

// The browser window that shows `source`, if it is a visible tab.
views::Widget* BrowserWidgetFor(content::WebContents* source) {
  if (!source || !source->GetNativeView()) {
    return nullptr;
  }
  views::Widget* const widget =
      views::Widget::GetTopLevelWidgetForNativeView(source->GetNativeView());
  return widget && widget->IsVisible() && !widget->IsMinimized() ? widget
                                                                 : nullptr;
}

// A marked tab that may open a peek right now.
PeekSource* ActiveSource(content::WebContents* source) {
  PeekSource* const peek_source =
      source ? PeekSource::FromWebContents(source) : nullptr;
  if (!peek_source || !peek_source->enabled() || peek_source->forwarding() ||
      source->GetBrowserContext()->IsOffTheRecord()) {
    return nullptr;
  }
  tabs::TabInterface* const tab = tabs::TabInterface::MaybeGetFromContents(source);
  return tab && tab->IsActivated() ? peek_source : nullptr;
}

content::WebContents* ShowURLInPeek(content::WebContents* source,
                                    const content::OpenURLParams& params) {
  PeekSource* const peek_source = ActiveSource(source);
  views::Widget* const widget = BrowserWidgetFor(source);
  if (!peek_source || !widget || !params.url.SchemeIsHTTPOrHTTPS()) {
    return nullptr;
  }
  content::WebContents::CreateParams create_params(
      source->GetBrowserContext());
  std::unique_ptr<content::WebContents> contents =
      content::WebContents::Create(create_params);
  content::NavigationController::LoadURLParams load_params(params);
  // The source tab's frame does not exist in the new contents.
  load_params.frame_tree_node_id = content::FrameTreeNodeId();
  contents->GetController().LoadURLWithParams(load_params);
  return peek_source->Show(std::move(contents), *widget);
}

// Keeps a favourite's tab on its site: a link click to another site opens in
// a peek, and the tab stays where it is.
class PeekNavigationThrottle final : public content::NavigationThrottle {
 public:
  explicit PeekNavigationThrottle(content::NavigationThrottleRegistry& registry)
      : content::NavigationThrottle(registry) {}

  ThrottleCheckResult WillStartRequest() override {
    content::NavigationHandle* const handle = navigation_handle();
    content::WebContents* const contents = handle->GetWebContents();
    if (!ActiveSource(contents) || !BrowserWidgetFor(contents) || !handle->IsInPrimaryMainFrame() ||
        !handle->IsRendererInitiated() || !handle->WasInitiatedByLinkClick() ||
        !handle->HasUserGesture() || handle->IsPost() ||
        handle->IsHistory() || handle->IsSameDocument() ||
        handle->GetReloadType() != content::ReloadType::NONE ||
        !ui::PageTransitionCoreTypeIs(handle->GetPageTransition(),
                                      ui::PAGE_TRANSITION_LINK) ||
        !ShouldPeekSameTabNavigation(
            contents->GetPrimaryMainFrame()->GetLastCommittedURL(),
            handle->GetURL())) {
      return PROCEED;
    }
    content::OpenURLParams params =
        content::OpenURLParams::FromNavigationHandle(handle);
    params.disposition = WindowOpenDisposition::NEW_FOREGROUND_TAB;
    params.frame_tree_node_id = content::FrameTreeNodeId();
    // Opened after this navigation is cancelled, outside its callbacks.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<content::WebContents> source,
               content::OpenURLParams params) {
              if (source && !ShowURLInPeek(source.get(), params)) {
                // The peek could not open (for example the window is
                // hidden): open the link the ordinary way instead.
                source->OpenURL(params, {});
              }
            },
            contents->GetWeakPtr(), std::move(params)));
    return CANCEL_AND_IGNORE;
  }

  const char* GetNameForLogging() override { return "BreezerPeekThrottle"; }
};

}  // namespace

void SetSource(content::WebContents* contents, bool enabled) {
  if (!contents) {
    return;
  }
  if (enabled) {
    PeekSource::GetOrCreateForWebContents(contents)->set_enabled(true);
  } else if (PeekSource* const source = PeekSource::FromWebContents(contents)) {
    source->set_enabled(false);
  }
}

bool IsSource(content::WebContents* contents) {
  PeekSource* const source =
      contents ? PeekSource::FromWebContents(contents) : nullptr;
  return source && source->enabled();
}

content::WebContents* MaybeShowNewContents(
    content::WebContents* source,
    std::unique_ptr<content::WebContents>& new_contents,
    WindowOpenDisposition disposition,
    bool user_gesture) {
  if (!new_contents || !user_gesture ||
      disposition != WindowOpenDisposition::NEW_FOREGROUND_TAB) {
    return nullptr;
  }
  PeekSource* const peek_source = ActiveSource(source);
  views::Widget* const widget = BrowserWidgetFor(source);
  if (!peek_source || !widget ||
      new_contents->GetBrowserContext() != source->GetBrowserContext()) {
    return nullptr;
  }
  return peek_source->Show(std::move(new_contents), *widget);
}

content::WebContents* MaybeShowURL(content::WebContents* source,
                                   const content::OpenURLParams& params) {
  if (params.disposition != WindowOpenDisposition::NEW_FOREGROUND_TAB ||
      !params.is_renderer_initiated || !params.user_gesture) {
    return nullptr;
  }
  return ShowURLInPeek(source, params);
}

void MaybeCreateAndAddNavigationThrottle(
    content::NavigationThrottleRegistry& registry) {
  content::NavigationHandle& handle = registry.GetNavigationHandle();
  if (handle.IsInPrimaryMainFrame() && handle.IsRendererInitiated() &&
      IsSource(handle.GetWebContents())) {
    registry.AddThrottle(std::make_unique<PeekNavigationThrottle>(registry));
  }
}

bool ShouldPeekSameTabNavigation(const GURL& current_url,
                                 const GURL& destination_url) {
  return current_url.SchemeIsHTTPOrHTTPS() &&
         destination_url.SchemeIsHTTPOrHTTPS() &&
         !net::registry_controlled_domains::SameDomainOrHost(
             current_url, destination_url,
             net::registry_controlled_domains::INCLUDE_PRIVATE_REGISTRIES);
}

}  // namespace breezer_peek
