// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

// Runs the New Tab box on the address bar's own engine: the same providers,
// preferences, default search engine and URL-or-search decision.

#include "chrome/browser/extensions/api/breezer_private/breezer_private_api.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/feature_list.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/strcat.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "chrome/browser/autocomplete/chrome_autocomplete_provider_client.h"
#include "chrome/browser/omnibox/chrome_omnibox_navigation_observer_base.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/omnibox/browser/autocomplete_classifier.h"
#include "components/omnibox/browser/autocomplete_controller.h"
#include "components/omnibox/browser/autocomplete_controller_config.h"
#include "components/omnibox/browser/autocomplete_enums.h"
#include "components/omnibox/browser/autocomplete_input.h"
#include "components/omnibox/browser/autocomplete_match.h"
#include "components/omnibox/browser/autocomplete_match_type.h"
#include "components/omnibox/browser/autocomplete_result.h"
#include "components/omnibox/common/omnibox_features.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_service.h"
#include "content/public/browser/document_user_data.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "third_party/metrics_proto/omnibox_event.pb.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"
#include "url/url_constants.h"

namespace extensions {
namespace {

constexpr char kNewTabPath[] = "/newtab.html";
// UTF-8 bytes. Longer drafts are never addresses; the page searches instead.
constexpr size_t kMaxInputBytes = 8192;

struct Selection {
  std::u16string text;
  AutocompleteMatch match;
  bool typed_without_scheme = false;
  bool typed_with_http_scheme = false;
};

// One address-bar query session per New Tab document. It dies with the
// document, so no query or result outlives the page that asked.
class OmniboxSession final
    : public content::DocumentUserData<OmniboxSession>,
      public AutocompleteController::Observer {
 public:
  using ResultCallback = base::OnceCallback<void(base::DictValue)>;

  OmniboxSession(const OmniboxSession&) = delete;
  OmniboxSession& operator=(const OmniboxSession&) = delete;
  ~OmniboxSession() override;

  // Starts a query and returns the results that are ready immediately.
  base::DictValue Query(const std::u16string& text, bool prevent_inline);
  // Runs `callback` once results newer than `revision` exist. A newer query or
  // request answers the older one, so at most one is ever waiting.
  void Next(int revision, ResultCallback callback);
  // What Enter does with `text` when no visible suggestion stands for it.
  std::optional<Selection> Classify(const std::u16string& text);
  // A suggestion the page was shown, exactly as it was when shown.
  std::optional<Selection> Find(int revision, int index) const;

  // AutocompleteController::Observer:
  void OnResultChanged(AutocompleteController* controller,
                       bool default_match_changed) override;

 private:
  friend content::DocumentUserData<OmniboxSession>;

  // Suggestions as published, so a result that arrives between the page
  // painting a row and the person choosing it cannot change the choice.
  struct Snapshot {
    int revision = -1;
    std::vector<Selection> selections;
  };

  explicit OmniboxSession(content::RenderFrameHost* rfh);

  AutocompleteInput MakeInput(const std::u16string& text);
  Selection MakeSelection(const AutocompleteMatch& match) const;
  bool IsOpenable(const AutocompleteMatch& match) const;
  base::DictValue Publish();
  void AnswerPending();

  std::unique_ptr<AutocompleteController> controller_;
  std::u16string text_;
  int revision_ = 0;
  Snapshot shown_;
  Snapshot previous_;
  ResultCallback pending_;

  DOCUMENT_USER_DATA_KEY_DECL();
};

DOCUMENT_USER_DATA_KEY_IMPL(OmniboxSession);

OmniboxSession::OmniboxSession(content::RenderFrameHost* rfh)
    : content::DocumentUserData<OmniboxSession>(rfh),
      controller_(std::make_unique<AutocompleteController>(
          std::make_unique<ChromeAutocompleteProviderClient>(
              Profile::FromBrowserContext(rfh->GetBrowserContext())),
          AutocompleteControllerConfig{
              .provider_types =
                  AutocompleteClassifier::DefaultOmniboxProviders(),
              .show_iph_matches = false})) {
  controller_->AddObserver(this);
}

OmniboxSession::~OmniboxSession() {
  controller_->RemoveObserver(this);
  if (pending_) {
    // The waiting API call must still answer, but not while its document is
    // being torn down.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(std::move(pending_), base::DictValue()
                                                .Set("revision", revision_)
                                                .Set("done", true)
                                                .Set("matches",
                                                     base::ListValue())));
  }
}

base::DictValue OmniboxSession::Query(const std::u16string& text,
                                      bool prevent_inline) {
  AnswerPending();
  text_ = text;
  if (text.empty()) {
    controller_->Stop(AutocompleteStopReason::kClobbered);
  } else {
    AutocompleteInput input = MakeInput(text);
    input.set_prevent_inline_autocomplete(prevent_inline);
    controller_->Start(input);
  }
  ++revision_;
  return Publish();
}

void OmniboxSession::Next(int revision, ResultCallback callback) {
  AnswerPending();
  if (revision < revision_ || controller_->done()) {
    std::move(callback).Run(Publish());
    return;
  }
  pending_ = std::move(callback);
}

std::optional<Selection> OmniboxSession::Classify(const std::u16string& text) {
  AnswerPending();
  text_ = text;
  AutocompleteInput input = MakeInput(text);
  input.set_prevent_inline_autocomplete(true);
  input.set_omit_asynchronous_matches(true);
  controller_->Start(input);
  ++revision_;
  const AutocompleteMatch* const match = controller_->result().default_match();
  if (!match || !IsOpenable(*match)) {
    return std::nullopt;
  }
  return MakeSelection(*match);
}

std::optional<Selection> OmniboxSession::Find(int revision, int index) const {
  for (const Snapshot* snapshot : {&shown_, &previous_}) {
    if (snapshot->revision == revision && index >= 0 &&
        static_cast<size_t>(index) < snapshot->selections.size()) {
      return snapshot->selections[index];
    }
  }
  return std::nullopt;
}

void OmniboxSession::OnResultChanged(AutocompleteController* controller,
                                     bool default_match_changed) {
  ++revision_;
  AnswerPending();
}

AutocompleteInput OmniboxSession::MakeInput(const std::u16string& text) {
  // The classification the address bar itself reports on a New Tab.
  AutocompleteInput input(
      text, text.length(),
      ::metrics::OmniboxEventProto::INSTANT_NTP_WITH_OMNIBOX_AS_STARTING_FOCUS,
      controller_->autocomplete_provider_client()->GetSchemeClassifier(),
      base::FeatureList::IsEnabled(::omnibox::kDefaultTypedNavigationsToHttps));
  if (content::WebContents* const contents =
          content::WebContents::FromRenderFrameHost(&render_frame_host())) {
    input.set_current_url(contents->GetVisibleURL());
  }
  return input;
}

Selection OmniboxSession::MakeSelection(const AutocompleteMatch& match) const {
  const AutocompleteInput& input = controller_->input();
  return {text_, match, input.added_default_scheme_to_typed_url(),
          input.typed_url_had_http_scheme() &&
              match.type == ::omnibox::AutocompleteMatchType::kUrlWhatYouTyped};
}

// Rows the address bar answers with its own UI (keyword chips, actions, tips)
// have nothing to open from a page.
bool OmniboxSession::IsOpenable(const AutocompleteMatch& match) const {
  TemplateURLService* const service =
      controller_->autocomplete_provider_client()->GetTemplateURLService();
  if (!match.destination_url.is_valid() ||
      match.destination_url.SchemeIs(url::kJavaScriptScheme) ||
      match.type == ::omnibox::AutocompleteMatchType::kNullResultMessage ||
      match.takeover_action || match.IsIphSuggestion() ||
      match.ShouldHideBasedOnStarterPack(service)) {
    return false;
  }
  const TemplateURL* const engine =
      service ? match.GetTemplateURL(service) : nullptr;
  return !engine || engine->type() != TemplateURL::OMNIBOX_API_EXTENSION;
}

base::DictValue OmniboxSession::Publish() {
  if (shown_.revision != revision_) {
    previous_ = std::move(shown_);
    shown_ = Snapshot();
    shown_.revision = revision_;
  } else {
    shown_.selections.clear();
  }
  const AutocompleteResult& result = controller_->result();
  const AutocompleteMatch* const default_match = result.default_match();
  base::ListValue matches;
  if (!text_.empty()) {
    for (const AutocompleteMatch& match : result) {
      if (!IsOpenable(match)) {
        continue;
      }
      const bool is_search = AutocompleteMatch::IsSearchType(match.type);
      const bool swap = match.swap_contents_and_description;
      matches.Append(
          base::DictValue()
              .Set("kind", is_search ? "search" : "url")
              .Set("contents", base::UTF16ToUTF8(swap ? match.description
                                                      : match.contents))
              .Set("description", base::UTF16ToUTF8(swap ? match.contents
                                                         : match.description))
              .Set("url", match.destination_url.spec())
              .Set("fillIntoEdit", base::UTF16ToUTF8(match.fill_into_edit))
              .Set("inlineAutocompletion",
                   base::UTF16ToUTF8(match.inline_autocompletion))
              .Set("isDefault", &match == default_match));
      shown_.selections.push_back(MakeSelection(match));
    }
  }
  return base::DictValue()
      .Set("revision", revision_)
      .Set("done", text_.empty() || controller_->done())
      .Set("matches", std::move(matches));
}

void OmniboxSession::AnswerPending() {
  if (pending_) {
    std::move(pending_).Run(Publish());
  }
}

// Returns the calling New Tab's session, or null for any other caller.
OmniboxSession* GetSession(ExtensionFunction& function, const GURL& source) {
  content::RenderFrameHost* const frame = function.render_frame_host();
  if (!frame || !frame->IsInPrimaryMainFrame() ||
      source.GetPath() != kNewTabPath) {
    return nullptr;
  }
  return OmniboxSession::GetOrCreateForCurrentDocument(frame);
}

std::optional<std::u16string> ReadText(const base::DictValue& request) {
  const std::string* const text = request.FindString("text");
  if (!text || text->size() > kMaxInputBytes) {
    return std::nullopt;
  }
  return base::UTF8ToUTF16(*text);
}

}  // namespace

ExtensionFunction::ResponseAction
BreezerPrivateQueryOmniboxFunction::RunFunction() {
  OmniboxSession* const session = GetSession(*this, source_url());
  if (!session) {
    return RespondNow(Error("Ask for suggestions from a Breezer New Tab."));
  }
  if (args().size() != 1 || !args()[0].is_dict()) {
    return RespondNow(Error("Invalid suggestion request."));
  }
  const base::DictValue& request = args()[0].GetDict();
  const std::optional<std::u16string> text = ReadText(request);
  const std::optional<bool> prevent_inline = request.FindBool("preventInline");
  if (request.size() != 2 || !text || !prevent_inline) {
    return RespondNow(Error("Invalid suggestion request."));
  }
  return RespondNow(WithArguments(session->Query(*text, *prevent_inline)));
}

ExtensionFunction::ResponseAction
BreezerPrivateNextOmniboxResultFunction::RunFunction() {
  OmniboxSession* const session = GetSession(*this, source_url());
  if (!session) {
    return RespondNow(Error("Ask for suggestions from a Breezer New Tab."));
  }
  if (args().size() != 1 || !args()[0].is_int()) {
    return RespondNow(Error("Invalid suggestion request."));
  }
  session->Next(
      args()[0].GetInt(),
      base::BindOnce(&BreezerPrivateNextOmniboxResultFunction::OnResult, this));
  return did_respond() ? AlreadyResponded() : RespondLater();
}

void BreezerPrivateNextOmniboxResultFunction::OnResult(
    base::DictValue result) {
  Respond(WithArguments(std::move(result)));
}

ExtensionFunction::ResponseAction
BreezerPrivateOpenOmniboxFunction::RunFunction() {
  OmniboxSession* const session = GetSession(*this, source_url());
  if (!session || !user_gesture()) {
    return RespondNow(Error("Open an address from a Breezer New Tab."));
  }
  content::WebContents* const contents = GetSenderWebContents();
  BrowserWindowInterface* const browser = GetCallerBrowser();
  if (!contents || !browser || browser->IsDeleteScheduled() ||
      browser->GetType() != BrowserWindowInterface::TYPE_NORMAL ||
      browser->GetTabStripModel()->GetActiveWebContents() != contents) {
    return RespondNow(Error("The calling tab is unavailable."));
  }
  if (args().size() != 1 || !args()[0].is_dict()) {
    return RespondNow(Error("Invalid address."));
  }
  const base::DictValue& request = args()[0].GetDict();
  const std::optional<std::u16string> text = ReadText(request);
  const std::optional<int> revision = request.FindInt("revision");
  const std::optional<int> index = request.FindInt("index");
  if (!text || text->empty() || revision.has_value() != index.has_value() ||
      request.size() != (index ? 3u : 1u)) {
    return RespondNow(Error("Invalid address."));
  }
  const std::optional<Selection> selection =
      index ? session->Find(*revision, *index) : session->Classify(*text);
  if (!selection) {
    return RespondNow(Error("That address is no longer available."));
  }

  // The same navigation the address bar starts for this match, pinned to the
  // calling tab.
  const AutocompleteMatch& match = selection->match;
  NavigateParams params(
      browser, match.destination_url,
      ui::PageTransitionFromInt(match.transition |
                                ui::PAGE_TRANSITION_FROM_ADDRESS_BAR));
  params.source_contents = contents;
  params.disposition = WindowOpenDisposition::CURRENT_TAB;
  params.is_using_https_as_default_scheme = selection->typed_without_scheme;
  params.url_typed_with_http_scheme = selection->typed_with_http_scheme;
  for (const auto& header : match.extra_headers) {
    base::StrAppend(&params.extra_headers,
                    {header.first, ": ", header.second, "\r\n"});
  }
  Profile* const profile = GetProfile();
  const base::WeakPtr<content::NavigationHandle> navigation =
      ::Navigate(&params);
  // Learns the choice, as the address bar does, once the page loads.
  ChromeOmniboxNavigationObserverBase::Create(
      navigation.get(), profile, selection->text, match, AutocompleteMatch());
  return RespondNow(NoArguments());
}

}  // namespace extensions
