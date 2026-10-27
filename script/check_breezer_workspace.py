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

    fingerprint = workspace.fingerprint()
    require(re.fullmatch(r"[0-9a-f]{64}", fingerprint) is not None,
            "Workspace fingerprint is not lowercase SHA-256")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true",
                        help="Use only the prepared pinned-source cache")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="breezer-workspace-overlay-") as directory:
        tree = Path(directory).resolve()
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
        "and exposes the bounded appearance, collapse, and activeTab APIs."
    )
    print("Native compilation and real window/extension-host behavior still require the full macOS browser build.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, AssertionError) as error:
        sys.exit(f"FAIL: {error}")
