# Hidden native scrollbar scheduling

The existing workspace hook applies two fully pinned files to Chromium's
`chrome/browser/ui/views/tabs/shared/rounded_scroll_bar.{cc,h}`. It accepts the
licensed baseline, the earlier callback-only implementation and the exact
current payload. Unknown source fails before any workspace writes.

`View::SetLayerBounds` calls the implicit bounds animator before invoking
`Thumb::OnBoundsChanged`. Completing an animation in that callback still lets
the animator enqueue work first. The Thumb now installs a bounds animator that
checks `IsDrawn()` when each bounds request arrives. A hidden owning Thumb stops
its countdown, completes any older bounds request and writes the new target
directly. It creates no new BOUNDS sequence on this path. Drawn, detached-owner
and foreign-layer requests retain the base animator behavior and duration.

A weak owner reference, retained animator, request generation and delegate/layer
checks protect completion callbacks that detach, reparent or reenter. The
existing hidden callback still completes BOUNDS and OPACITY. Show, Hide, hover,
scrolling and model geometry retain their previous behavior. Other properties
are untouched. Geometry changes can still schedule lower-layer work.

## Preparation

After normal Chromium/Helium preparation, use the existing hook on quiescent
private source:

```sh
python3 script/apply_breezer_workspace.py "$CHROMIUM_SOURCE"
python3 script/apply_breezer_workspace.py --check "$CHROMIUM_SOURCE"
python3 script/apply_breezer_workspace.py --fingerprint
```

The normal build wrapper calls this hook. Its fingerprint includes both native
files, the known donors, pins and regression fixtures. Existing preparation
markers reject stale reuse. Preserve compiled caches and markers; use the
normal fresh-build or verified migration route.

## Offline regression

Python 3 and a C++20 compiler with AddressSanitizer and UndefinedBehaviorSanitizer
are required. All inputs are tracked; these commands download nothing:

```sh
python3 -B script/check_breezer_hidden_scrollbar.py --failure-controls
python3 -B script/check_breezer_hidden_scrollbar_prestart.py
python3 -B script/check_breezer_workspace.py --offline
python3 -B script/check_breezer_preparation.py
```

The first check exercises fifteen actual callback/lifecycle cases and six
deliberately broken callbacks. The second extracts actual Init and lifecycle
methods into a bounded twenty-two-case fixture. Pinned reference View, Layer
and animator methods drive its lower-layer doubles. The reference provenance
and Chromium license are retained beside it.

Reproduce the pre-start failure against the previous callback-only code:

```sh
python3 -B script/check_breezer_hidden_scrollbar_prestart.py \
  --source features/performance/hidden-scrollbar/previous/rounded_scroll_bar.cc \
  --case hidden-no-start
```

That control must fail because hidden SetBounds enqueues a scheduler request.
Use `--output DIRECTORY` to retain extracted C++, commands and logs. Tests cover
hidden ancestors, visibility changes at call time, final targets, timer ordering,
reentrancy, owner destruction, detachment, reparenting, unrelated properties and
drawn-path observations. Preparation checks cover both files, previous-source
migration, idempotence, source drift and fingerprints. The full workspace fixture
checks all targets and cache preservation before writes.

## Proof limits

The exact payload compiled in the private PGO build on the PC and passed the Mac
two-launch filtering/sidebar check. That check does not certify visible native
scrollbar presentation, drag, DPI, accessibility or arbitrary deletion observers.
The standalone doubles do not establish those behaviors either.

The callback's local lifetime handling does not make a View caller safe if an
arbitrary observer deletes that View and the caller subsequently accesses it.
Property completion also completes the containing sequence; arbitrary future
mixed-property sequences are outside this contract.

No saving is established for this pre-start candidate. The previous callback-only
candidate missed all eight balanced performance ceilings. The combined current
candidate still needs a fresh guarded comparison; performance and merge remain
held until its required gates pass.
