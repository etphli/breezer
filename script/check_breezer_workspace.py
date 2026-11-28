#!/usr/bin/env python3
"""Exercise the Breezer native workspace overlay on a pinned source fixture."""

import argparse
import hashlib
from pathlib import Path
import re
import sys
import tempfile

import apply_breezer_workspace as workspace
import check_ai_overlay as source_fixture


TAB_GROUP_UPSTREAM_FILES = (
    'chrome/browser/ui/views/frame/horizontal_tab_strip_region_view.cc',
    'chrome/browser/ui/views/frame/horizontal_tab_strip_region_view.h',
    'chrome/browser/ui/tabs/tab_strip_model.cc',
)


def file_hashes(tree):
    return {
        path.relative_to(tree).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(tree.rglob("*"))
        if path.is_file()
    }


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def check_overlay(tree, originals):
    paths = tuple(workspace.replacements())

    before = file_hashes(tree)
    try:
        workspace.apply(tree, check=True)
    except ValueError:
        pass
    else:
        raise AssertionError("--check accepted a fixture without the workspace overlay")
    require(file_hashes(tree) == before, "--check modified the source fixture")

    changed = workspace.apply(tree)
    require(changed > 0, "First apply did not change or add any files")
    applied = file_hashes(tree)
    require(workspace.apply(tree) == 0, "Second apply was not idempotent")
    require(file_hashes(tree) == applied, "Idempotent apply changed source files")
    require(workspace.apply(tree, check=True) == 0, "Applied overlay failed check mode")
    check_tab_groups(tree, originals)
    window_features = (tree / workspace.WINDOW_FEATURES).read_text()
    controller_creation = 'CreateInstance<HeliumLayoutStateController>'
    require(window_features.count(controller_creation) == 1,
            'Layout controller must be created exactly once per window')
    require(window_features.index(controller_creation) < window_features.index('restored_state_collapsed ='),
            'Workspace defaults must be initialized before sidebar state is read')

    # Model a previous interrupted run that patched only part of the files.
    interrupted = paths[0]
    (tree / interrupted).write_bytes(originals[interrupted])
    require(workspace.apply(tree) > 0, "Interrupted apply did not converge")
    require(file_hashes(tree) == applied, "Interrupted apply did not converge to one result")

    # A moved anchor must fail before writing any other target.
    corrupted = paths[0]
    target = tree / corrupted
    intact = target.read_bytes()
    target.write_bytes(intact.replace(b"base_tab_strip_region_view.h", b"moved_region_header.h", 1))
    drifted = file_hashes(tree)
    try:
        workspace.apply(tree)
    except ValueError:
        pass
    else:
        raise AssertionError("Changed source anchor did not fail closed")
    require(file_hashes(tree) == drifted, "Anchor failure partially modified the source fixture")
    target.write_bytes(intact)

    # Unknown donor bytes, including diagnostic prefixes and changes outside the
    # callback, must fail before repairing an earlier unapplied workspace file.
    scrollbar = tree / workspace.HIDDEN_SCROLLBAR
    fixed_scrollbar = scrollbar.read_bytes()
    baseline = originals[workspace.HIDDEN_SCROLLBAR]
    for content in (baseline + b"// diagnostic marker\n",
                    b"// diagnostic marker\n" + fixed_scrollbar,
                    fixed_scrollbar.replace(b"return true;", b"return false;", 1)):
        scrollbar.write_bytes(content)
        (tree / interrupted).write_bytes(originals[interrupted])
        drifted = file_hashes(tree)
        try:
            workspace.apply(tree)
        except ValueError:
            pass
        else:
            raise AssertionError("Unknown hidden scrollbar donor did not fail closed")
        require(file_hashes(tree) == drifted, "Scrollbar failure partially wrote workspace files")
    scrollbar.write_bytes(fixed_scrollbar)
    require(workspace.apply(tree) > 0, "Workspace recovery did not converge")
    require(file_hashes(tree) == applied, "Scrollbar drift control did not restore fixture")

    added = workspace.added_files()
    idl = added["chrome/common/extensions/api/breezer_private.idl"].read_text()
    api = added[
        "chrome/browser/extensions/api/breezer_private/breezer_private_api.cc"
    ].read_text()
    host = added[
        "chrome/browser/ui/views/frame/breezer_workspace_view.cc"
    ].read_text()
    region = workspace._region_replacements()
    feature = next(
        after
        for _, after in workspace.replacements()[
            "chrome/common/extensions/api/_api_features.json"
        ]
    )

    require("authorizeCurrentPage(BooleanCallback callback)" in idl,
            "Private API IDL does not declare authorizeCurrentPage")
    for function in ("getAppearance", "setAppearance", "setSidebarCollapsed"):
        require(function in idl, f"Private API IDL does not declare {function}")
    constants = added['chrome/browser/ui/helium/breezer_workspace_prefs.h'].read_text()
    require('"namgcidocfgliiedlkdafcmifpdfiakj"' in constants and
            'breezer_workspace::kExtensionId' in host,
            "Native host is not restricted to the expected component ID")
    require("workspace.html#/sidebar?w=" in host,
            "Native host does not pass the validated Chromium window ID")
    require("user_gesture()" in api and "GrantIfRequested(extension())" in api,
            "authorizeCurrentPage does not require a gesture and grant activeTab")
    require("GetExtensionWindowController()" in api,
            "Private API does not resolve the caller's actual window")
    require("extension()->id() != breezer_workspace::kExtensionId" in api,
            "Private API does not enforce the exact component ID")
    require(
        hashlib.sha1(workspace.COMPONENT_ID.encode()).hexdigest().upper()
        in feature,
        "Private API feature allowlist hash does not match the component ID",
    )
    reset = host.split("void BreezerWorkspaceView::ResetExtensionContent()", 1)[1]
    require(reset.index("RemoveChildViewT") < reset.index("extension_host_.reset()"),
            "Embedded view must be removed before its extension host is reset")
    replacement_text = "\n".join(after for _, after in region)
    require("GetViewByID(BreezerWorkspaceView::kViewId)" in replacement_text,
            "Vertical region does not locate the local workspace wrapper")
    require("native_tab_strip->SetVisible(!workspace_available)" in replacement_text,
            "Native visible tab rows are not hidden while the extension host is active")

    # These source checks supplement, but do not replace, compiled API tests.
    require('long sidebarFontSize;' in idl and 'long? sidebarFontSize;' in idl,
            "Sidebar font size is missing from the bounded schema")
    for bound, value in (("Default", 15), ("Min", 12), ("Max", 20)):
        require(f'k{bound}SidebarFontSize = {value};' in constants,
                f"Incorrect {bound.lower()} sidebar font size")
    setter = api.split('BreezerPrivateSetAppearanceFunction::RunFunction()', 1)[1].split(
        'BreezerPrivateSetSidebarCollapsedFunction', 1)[0]
    require(setter.index('ParseAppearancePatch') < setter.index('ApplyAppearance') and
            setter.index('CheckAppearanceWritable') < setter.index('ApplyAppearance'),
            "Appearance writes must follow whole-patch validation and policy checks")
    require('!IsUserModifiable(prefs, breezer_workspace::prefs::kSidebarFontSize)' in api and
            'value->GetInt() < breezer_workspace::kMinSidebarFontSize' in api and
            'value->GetInt() > breezer_workspace::kMaxSidebarFontSize' in api,
            "Font size is missing native bounds or policy checks")
    controller = (tree / workspace.LAYOUT_CONTROLLER).read_text()
    require('!prefs->GetUserPrefValue(path)' in controller and
            'pref->IsUserModifiable() && pref->IsDefaultValue()' in controller and
            'kAppearanceDefaultsVersion) >=' in controller,
            "Versioned migration must preserve explicit and managed choices")
    require('SetBoolean(prefs::kVerticalTabsExpandOnHoverEnabled' not in controller,
            "Defaults migration must not interpret the disabled auto-expand switch")
    pages = (tree / 'chrome/browser/ui/chrome_pages.cc').read_text()
    root_settings = pages.split('void ShowSettings(BrowserWindowInterface* browser)', 1)[1].split(
        'void ShowSettingsSubPage(', 1)[0]
    require('workspace.html#/settings' in root_settings and
            'IsOffTheRecord()' in root_settings and 'enabled_extensions()' in root_settings and
            'ShowSettingsSubPage(browser, std::string());' in root_settings,
            "Default settings entry must use the hub with a native fallback")
    require('ShowSingletonTabIgnorePathOverwriteNTP(browser, GetSettingsUrl(sub_page));' in pages,
            "Native settings category navigation changed")

    check_peek(tree, added, idl, api)
    check_omnibox(added, idl)
    check_numbered_tabs(tree, host)

    fingerprint = workspace.fingerprint()
    require(re.fullmatch(r"[0-9a-f]{64}", fingerprint) is not None,
            "Workspace fingerprint is not lowercase SHA-256")


def check_tab_groups(tree, originals):
    for name in TAB_GROUP_UPSTREAM_FILES:
        require((tree / name).read_bytes() == originals[name],
                f'Tab grouping must keep the upstream horizontal strip and tab model: {name}')

    color_hooks = {
        'chrome/browser/ui/views/tabs/groups/tab_group_editor_bubble_view.cc': (
            'std::make_unique<BreezerGroupColorView>',
            'breezer_tab_groups::SetColor(self->browser_->GetProfile(), self->group_, color)',
            'breezer_tab_groups::SetColor(self->browser_->GetProfile(), self->group_, std::nullopt)',
        ),
        'chrome/browser/ui/views/tabs/tab.cc': ('breezer_tab_groups::GetColor(',),
        'chrome/browser/ui/views/tabs/tab_group_header.cc': ('breezer_tab_groups::GetColor(',),
        'chrome/browser/ui/views/tabs/tab_group_views.cc': ('breezer_tab_groups::GetColor(',),
        'chrome/browser/sessions/session_restore.cc': ('breezer_tab_groups::RestoreColor(',),
    }
    for name, hooks in color_hooks.items():
        source = (tree / name).read_text()
        for hook in hooks:
            require(hook in source, f'Missing native custom group colour hook in {name}: {hook}')


def check_numbered_tabs(tree, host):
    """Native dispatch contract only; physical key acceptance needs a build."""
    controller = (tree / 'chrome/browser/ui/browser_command_controller.cc').read_text()
    numbered = controller.split('    case IDC_SELECT_TAB_0:', 1)[1].split(
        '    case IDC_SELECT_LAST_TAB:', 1)[0]
    for slot in range(1, 8):
        require(f'case IDC_SELECT_TAB_{slot}:' in numbered,
                f'Numbered slot {slot} must share the native command route')
    require(numbered.index('workspace->SelectNumberedTab(') <
            numbered.index('\n      SelectNumberedTab('),
            'Saved slots must be offered the command before native tab indices')
    reserved = controller.split('  // The custom sidebar owns saved slots', 1)[1].split(
        '  return command_id == IDC_CLOSE_TAB', 1)[0]
    require('command_id >= IDC_SELECT_TAB_0 && command_id <= IDC_SELECT_TAB_7' in reserved and
            'BreezerWorkspaceView::FromBrowser(browser_)' in reserved and
            'return true;' in reserved,
            'Saved-slot commands must reach native dispatch while a page has focus')
    last = controller.split('    case IDC_SELECT_LAST_TAB:', 1)[1].split(
        '    case IDC_DUPLICATE_TAB:', 1)[0]
    require('SelectLastTab(' in last and 'workspace' not in last,
            'Command+9 must keep native last-tab selection')
    lookup = host.split('BreezerWorkspaceView* BreezerWorkspaceView::FromBrowser(', 1)[1].split(
        'bool BreezerWorkspaceView::SelectNumberedTab(', 1)[0]
    require('IsOffTheRecord()' in lookup and 'GetBrowserViewForBrowser(browser)' in lookup and
            'GetViewByID(kViewId)' in lookup and 'workspace->is_available()' in lookup,
            'Commands must use only the originating browser\'s available custom sidebar')
    dispatch = host.split('bool BreezerWorkspaceView::SelectNumberedTab(', 1)[1].split(
        'void BreezerWorkspaceView::OnNumberedTabResult(', 1)[0]
    for token in ('index < 0 || index > 7', 'GetSidebarFrame()', 'if (!frame)',
                  'ExecuteJavaScriptInIsolatedWorld(', 'breezer-select-numbered-tab',
                  'cancelable:true', 'ISOLATED_WORLD_ID_CHROME_INTERNAL',
                  'weak_factory_.GetWeakPtr(), index, gesture'):
        require(token in dispatch, f'Missing bounded native shortcut dispatch: {token}')
    # A renderer that exits before replying drops the callback; the shortcut
    # must still fall back to native selection, outside the frame's teardown.
    require(re.search(r'mojo::WrapCallbackWithDefaultInvokeIfNotRun\(\s*'
                      r'base::BindPostTaskToCurrentDefault\(\s*'
                      r'base::BindOnce\(&BreezerWorkspaceView::OnNumberedTabResult,'
                      r'[^;]*\)\),\s*base::Value\(\)\)', dispatch) is not None,
            'A dropped numbered-tab reply must fall back to native selection')
    frame = host.split('BreezerWorkspaceView::GetSidebarFrame()', 1)[1].split(
        'void BreezerWorkspaceView::UpdateToolbarBackground()', 1)[0]
    for token in ('if (!is_available())', 'IsRenderFrameLive()', 'url.SchemeIs("chrome-extension")',
                  'url.GetHost() != breezer_workspace::kExtensionId', 'url.GetPath() != "/workspace.html"'):
        require(token in frame, f'Missing native sidebar document check: {token}')
    fallback = host.split('void BreezerWorkspaceView::OnNumberedTabResult(', 1)[1].split(
        'views::View* BreezerWorkspaceView::GetFocusableView()', 1)[0]
    require('!browser_->IsDeleteScheduled()' in fallback and
            '!handled.GetBool()' in fallback and
            'chrome::SelectNumberedTab(&*browser_, index, gesture)' in fallback,
            'Unhandled saved slots must retain native selection without reentering the command hook')


def check_peek(tree, added, idl, api):
    """Source contract for favourite-tab Peek. Runtime needs a compiled build."""
    delegate = (tree / workspace.PEEK_DELEGATE).read_text()
    add_new = delegate.split("BrowserWebContentsDelegate::AddNewContents(", 1)[1]
    require(add_new.index("breezer_peek::MaybeShowNewContents(") <
            add_new.index("FullscreenController* fullscreen_controller"),
            "New-tab requests must reach Peek before the browser handles them")
    open_url = delegate.split("BrowserWebContentsDelegate::OpenURLFromTab(", 1)[1]
    require(open_url.index("breezer_peek::MaybeShowURL(source, params)") <
            open_url.index("Navigate(popup_delegate->nav_params())"),
            "Foreground-tab links must reach Peek before Navigate")
    throttles = (tree / workspace.PEEK_THROTTLES).read_text()
    require(throttles.index("MetricsNavigationThrottle::CreateAndAdd(registry);") <
            throttles.index("breezer_peek::MaybeCreateAndAddNavigationThrottle(registry);"),
            "The Peek throttle must follow the metrics throttle")

    peek = added["chrome/browser/ui/views/breezer_peek/breezer_peek.cc"].read_text()
    throttle = peek.split("ThrottleCheckResult WillStartRequest()", 1)[1].split("return PROCEED;", 1)[0]
    for condition in ("ActiveSource(contents)", "IsInPrimaryMainFrame()", "IsRendererInitiated()",
                      "HasUserGesture()", "IsPost()", "IsHistory()",
                      "GetReloadType() != content::ReloadType::NONE", "PAGE_TRANSITION_LINK",
                      "ShouldPeekSameTabNavigation("):
        require(condition in throttle, f"Same-tab Peek is missing the {condition} condition")
    require("current_url.GetWithoutRef() != destination_url.GetWithoutRef()" in peek and "SchemeIsHTTPOrHTTPS()" in peek,
            "Same-tab Peek must include same-site pages while excluding fragment-only changes")
    show_new = peek.split("content::WebContents* MaybeShowNewContents(", 1)[1]
    require("disposition != WindowOpenDisposition::NEW_FOREGROUND_TAB" in show_new and
            "!user_gesture" in show_new and "target_url.SchemeIsHTTPOrHTTPS()" in show_new and "target_url.IsAboutBlank()" in show_new,
            "Only user-initiated foreground tabs may open a peek")
    require("!peek_source->enabled() || peek_source->forwarding()" in peek and
            "IsOffTheRecord()" in peek and "tab->IsActivated()" in peek,
            "Peek must be limited to marked, active, regular-profile tabs")
    require("IsEscape(event)" in peek.split("PreHandleKeyboardEvent(", 1)[1].split("}", 1)[0],
            "Escape must close a peek before the focused page sees it")
    expand = peek.split("  void Expand(WindowOpenDisposition disposition) {", 1)[1].split("\n  }\n", 1)[0]
    require("AddNewContents(&source, std::move(contents), url, disposition" in expand and
            "LoadURL" not in expand and "Reload" not in expand,
            "Peek promotion must move the live WebContents without loading it again")
    require("BreezerPeekSplit" in peek and
            "WindowOpenDisposition::NEW_SPLIT_VIEW" in peek and
            "!source_tab->IsSplit()" in peek,
            "Peek must offer the browser's split disposition only for a standalone source")
    require("FormatUrlForSecurityDisplay(url)" in peek and
            "net::IsCertStatusError(ssl.cert_status)" in peek and
            "content::SSLStatus::NORMAL_CONTENT" in peek,
            "Peek must show a security-formatted origin and warn about compromised connections")
    detach = peek.split("  void Detach() {", 1)[1].split("\n  }\n", 1)[0]
    require("InvalidateWeakPtrs()" in detach and "RemoveAllObservations()" in detach and
            "tab_subscriptions_.clear()" in detach and "SetDelegate(nullptr)" in detach,
            "A dismissed peek must stop receiving callbacks before it is destroyed")
    require("iframe" not in peek.lower() and "disable-web-security" not in peek,
            "Peek must host a real WebContents, not a frame workaround")
    entrance = peek.split("    widget_->Show();", 1)[1].split("\n  }\n", 1)[0]
    require("gfx::Animation::ShouldRenderRichAnimation()" in peek and "if (animate)" in entrance,
            "The Peek entrance must be skipped when the system asks for reduced motion")
    require("SetOpacity(" in entrance and not any(
                call in entrance for call in ("SetTransform", "SetBounds", "OnEnded", "OnAborted", "Unretained")),
            "The Peek entrance must fade only, keeping page input where it is drawn, and bind no callbacks")

    require("static void setPeekSources(" in idl and "long[] tabIds" in idl,
            "Private API IDL does not declare setPeekSources")
    setter = api.split("BreezerPrivateSetPeekSourcesFunction::RunFunction()", 1)[1]
    require("source_url().GetPath() != kWorkspacePath" in setter and
            "GetCallerBrowser()" in setter and "kMaxPeekSources" in setter and
            "breezer_peek::SetSource(" in setter,
            "setPeekSources must be bounded to the calling sidebar's own window")

    require("static void toggleSplitView(" in idl, "Private API IDL does not declare toggleSplitView")
    split = api.split("BreezerPrivateToggleSplitViewFunction::RunFunction()", 1)[1].split("\n}", 1)[0]
    require("!user_gesture()" in split and "GetCallerBrowser()" in split and
            "source_url().GetPath() != kWorkspacePath" in split,
            "toggleSplitView must require a gesture from the calling sidebar")
    require("tab_strip->RemoveSplit(" in api and "tab_strip->AddToNewSplit(" in api and
            "chrome::NewSplitTab(browser, split_tabs::SplitTabLayout::kSideBySide" in api,
            "Split View must pair, show the chooser and exit through Chromium's native model")

    require("static void showExtensionsMenu(" in idl,
            "Private API IDL does not declare showExtensionsMenu")
    menu = added[
        "chrome/browser/extensions/api/breezer_private/extensions_menu_api.cc"
    ].read_text().split("RunFunction()", 1)[1]
    require("!user_gesture()" in menu and "GetCallerBrowser()" in menu and
            'source_url().GetPath() != "/workspace.html"' in menu and
            menu.index("kShowExtensionsButton") < menu.index("ToggleExtensionsMenu()"),
            "showExtensionsMenu must require a gesture from the calling sidebar")

    pdf_context = added[
        "chrome/browser/extensions/api/breezer_private/pdf_context_api.cc"
    ].read_text()
    for function in ("isCurrentPdf", "captureCurrentPdfContext"):
        require(f"static void {function}(long tabId," in idl,
                f"Private API IDL does not declare {function}")
    pdf_eligibility = pdf_context.split("BreezerPrivateIsCurrentPdfFunction::RunFunction()", 1)[1].split("\n}", 1)[0]
    pdf_capture = pdf_context.split("BreezerPrivateCaptureCurrentPdfContextFunction::RunFunction()", 1)[1].split("\n}", 1)[0]
    require("!user_gesture()" in pdf_capture and "user_gesture()" not in pdf_eligibility and
            "GetActiveTab(GetCallerBrowser()" in pdf_capture and
            "GetActiveTab(GetCallerBrowser()" in pdf_eligibility,
            "PDF capture must require a gesture and only the calling panel's active tab")
    require("FindFullPagePdfExtensionHost" in pdf_context and
            "FindPdfChildFrame" in pdf_context and "pdf_frame->GetView()" in pdf_capture and
            "view->CopyFromSurface(" in pdf_capture and "gfx::IntersectRects(" in pdf_capture and
            "tab_document.AsRenderFrameHostIfValid()" in pdf_context and
            "pdf_document.AsRenderFrameHostIfValid()" in pdf_context,
            "PDF context must copy the trusted child viewport and revalidate both documents before returning")
    timer_start = pdf_capture.split("timeout_.Start(", 1)[1].split("view->CopyFromSurface(", 1)[0]
    on_copied = pdf_context.split("BreezerPrivateCaptureCurrentPdfContextFunction::OnCopied(", 1)[1].split("\n}", 1)[0]
    require("base::RetainedRef(this)" in timer_start and
            "keep_alive(this)" in on_copied.split("timeout_.Stop();", 1)[0],
            "PDF capture must retain the request through the timeout and through cancellation of that timer")
    research = api.split("BreezerPrivateReadResearchTabFunction::RunFunction()", 1)[1].split("\n}", 1)[0]
    research_timer = research.split("timeout_.Start(", 1)[1].split("ExecuteJavaScriptInIsolatedWorld(", 1)[0]
    research_text = api.split("BreezerPrivateReadResearchTabFunction::OnText(", 1)[1].split("\n}", 1)[0]
    require("base::RetainedRef(this)" in research_timer and
            research_text.index("did_respond()") < research_text.index("timeout_.Stop();"),
            "Research reads must answer by timeout when the renderer drops the script callback, and respond once")
    # Clipping must not split a surrogate pair into U+FFFD.
    extractor = added[
        "chrome/browser/extensions/api/breezer_private/research_text.h"
    ].read_text()
    require("/[\\uD800-\\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit" in extractor and
            "cut(raw, 24001)" in extractor and "cut(value, 24000)" in extractor and
            ".slice(0, 2400" not in extractor,
            "Research text clipping can split a surrogate pair")
    stats = added[
        "chrome/browser/extensions/api/breezer_private/browser_stats_api.cc"
    ].read_text()
    require("(title[title_length - 1] & 0xFC00) == 0xD800" in stats and
            "title.substr(0, title_length)" in stats and
            "title.substr(0, kMaxTitleInputLength)" not in stats,
            "Tab title clipping can split a surrogate pair")


def check_omnibox(added, idl):
    directory = "chrome/browser/extensions/api/breezer_private/"
    source = added[directory + "omnibox_api.cc"].read_text()
    require('"omnibox_api.cc"' in added[directory + "BUILD.gn"].read_text(),
            "The New Tab address API must be compiled")
    for function in ("queryOmnibox", "nextOmniboxResult", "openOmnibox"):
        require(f"static void {function}(" in idl,
                f"Private API IDL does not declare {function}")
        body = source.split(f"BreezerPrivate{function[0].upper() + function[1:]}Function::RunFunction()",
                            1)[1].split("\n}", 1)[0]
        require("GetSession(*this, source_url()," in body,
                f"{function} must be limited to a Breezer address field")
    require("AutocompleteClassifier::DefaultOmniboxProviders()" in source and
            "std::make_unique<ChromeAutocompleteProviderClient>(" in source and
            "INSTANT_NTP_WITH_OMNIBOX_AS_STARTING_FOCUS" in source,
            "New Tab suggestions must come from the address bar's own providers and context")
    session = source.split("OmniboxSession* GetSession(", 1)[1].split("\n}", 1)[0]
    require("IsInPrimaryMainFrame()" in session and "kNewTabPath" in session and
            "IsSidebarFrame(browser, frame)" in session and "GetIndexOfWebContents(" in source and
            'url.ref_piece().starts_with("/sidebar?w=")' in source,
            "Suggestions must be limited to the New Tab or the window-owned sidebar")
    opened = source.split("BreezerPrivateOpenOmniboxFunction::RunFunction()", 1)[1]
    require("params.source_contents = contents;" in opened and
            "contents != GetSenderWebContents()" in opened and
            "*tab_id != ExtensionTabUtil::GetTabId(contents)" in opened and
            "!user_gesture()" in opened and
            'request.FindString("url")' not in source and
            "SchemeIs(url::kJavaScriptScheme)" in source,
            "New Tab must open only native matches, in its own tab, and never run a script address")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    downloads = parser.add_mutually_exclusive_group()
    downloads.add_argument("--offline", action="store_true",
                           help="Use only the prepared pinned-source cache")
    downloads.add_argument("--no-cache", action="store_true",
                           help="Fetch the pinned fixture into temporary storage only")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="breezer-workspace-overlay-") as directory:
        temporary = Path(directory).resolve()
        tree = temporary / "source"
        tree.mkdir()
        if args.no_cache:
            source_fixture.CACHE = temporary / "pristine"
        originals = source_fixture.prepare(
            tree, offline=args.offline,
            wanted_paths=(set(workspace.replacements()) | set(TAB_GROUP_UPSTREAM_FILES))
                         - {workspace.HIDDEN_SCROLLBAR, workspace.HIDDEN_SCROLLBAR_HEADER},
        )
        # This target uses the exact licensed non-diagnostic PC donor, retained
        # in the checkout so clean-checkout regression replay needs no download.
        baseline = workspace.hidden_scrollbar_replacements()[0][0].encode("utf-8")
        scrollbar = tree / workspace.HIDDEN_SCROLLBAR
        scrollbar.parent.mkdir(parents=True, exist_ok=True)
        scrollbar.write_bytes(baseline)
        originals.add(workspace.HIDDEN_SCROLLBAR)
        header = tree / workspace.HIDDEN_SCROLLBAR_HEADER
        header.write_bytes(workspace.hidden_scrollbar_replacements(workspace.HIDDEN_SCROLLBAR_HEADER)[0][0].encode("utf-8"))
        originals.add(workspace.HIDDEN_SCROLLBAR_HEADER)
        original_bytes = {
            name: (tree / name).read_bytes()
            for name in originals
        }
        check_overlay(tree, original_bytes)

    print(
        "PASS: native workspace overlay applies to the pinned Chromium/Helium "
        f"source fixture ({len(originals)} upstream targets), checks idempotently, "
        "converges after interruption, rejects anchor drift without partial writes, "
        "and exposes the bounded appearance, collapse, activeTab, and Peek source APIs "
        "with the favourite-tab Peek hooks in place. "
        "The horizontal strip and tab grouping model match upstream, "
        "and native custom group colour hooks are present."
    )
    print("Native compilation and real window/extension-host behavior still require the full macOS browser build.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, AssertionError) as error:
        sys.exit(f"FAIL: {error}")
