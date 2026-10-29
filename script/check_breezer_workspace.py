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

    fingerprint = workspace.fingerprint()
    require(re.fullmatch(r"[0-9a-f]{64}", fingerprint) is not None,
            "Workspace fingerprint is not lowercase SHA-256")


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
                      "WasInitiatedByLinkClick()", "HasUserGesture()", "IsPost()", "IsHistory()",
                      "GetReloadType() != content::ReloadType::NONE", "PAGE_TRANSITION_LINK",
                      "ShouldPeekSameTabNavigation("):
        require(condition in throttle, f"Same-tab Peek is missing the {condition} condition")
    require("SameDomainOrHost(" in peek and "SchemeIsHTTPOrHTTPS()" in peek,
            "Same-tab Peek must be limited to cross-site http(s) links")
    show_new = peek.split("content::WebContents* MaybeShowNewContents(", 1)[1]
    require("disposition != WindowOpenDisposition::NEW_FOREGROUND_TAB" in show_new and
            "!user_gesture" in show_new and "!target_url.SchemeIsHTTPOrHTTPS()" in show_new,
            "Only user-initiated foreground tabs may open a peek")
    require("!peek_source->enabled() || peek_source->forwarding()" in peek and
            "IsOffTheRecord()" in peek and "tab->IsActivated()" in peek,
            "Peek must be limited to marked, active, regular-profile tabs")
    require("IsEscape(event)" in peek.split("PreHandleKeyboardEvent(", 1)[1].split("}", 1)[0],
            "Escape must close a peek before the focused page sees it")
    expand = peek.split("  void Expand() {", 1)[1].split("\n  }\n", 1)[0]
    require("AddNewContents(&source, std::move(contents)" in expand and
            "LoadURL" not in expand and "Reload" not in expand,
            "Expand must move the live WebContents without loading it again")
    detach = peek.split("  void Detach() {", 1)[1].split("\n  }\n", 1)[0]
    require("InvalidateWeakPtrs()" in detach and "RemoveAllObservations()" in detach and
            "tab_subscriptions_.clear()" in detach and "SetDelegate(nullptr)" in detach,
            "A dismissed peek must stop receiving callbacks before it is destroyed")
    require("iframe" not in peek.lower() and "disable-web-security" not in peek,
            "Peek must host a real WebContents, not a frame workaround")

    require("static void setPeekSources(" in idl and "long[] tabIds" in idl,
            "Private API IDL does not declare setPeekSources")
    setter = api.split("BreezerPrivateSetPeekSourcesFunction::RunFunction()", 1)[1]
    require("source_url().GetPath() != kWorkspacePath" in setter and
            "GetCallerBrowser()" in setter and "kMaxPeekSources" in setter and
            "breezer_peek::SetSource(" in setter,
            "setPeekSources must be bounded to the calling sidebar's own window")


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
            tree, offline=args.offline, wanted_paths=tuple(workspace.replacements())
        )
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
        "with the favourite-tab Peek hooks in place."
    )
    print("Native compilation and real window/extension-host behavior still require the full macOS browser build.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, AssertionError) as error:
        sys.exit(f"FAIL: {error}")
