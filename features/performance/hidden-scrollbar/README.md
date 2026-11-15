# Hidden native scrollbar bounds completion

The production workspace overlay applies `payload/rounded_scroll_bar.cc` to
`chrome/browser/ui/views/tabs/shared/rounded_scroll_bar.cc`. `pins.json` accepts
only the exact non-diagnostic PC donor or the exact candidate. The baseline and
payload retain Chromium's copyright header and `LICENSE.chromium`.

`View::SetLayerBounds` starts the implicit BOUNDS animation before
`Thumb::OnBoundsChanged`. The hidden callback stops the hide countdown, retains
the animator, completes BOUNDS and OPACITY to their existing final targets, then
returns without accessing the view again. It does not change model geometry,
skip layout, force opacity to zero, disable global animation or add per-tab state.
The drawn branch and every other method retain their original bytes.

This corrects an observed scheduling owner. It does not establish a CPU saving
or satisfy a performance ceiling. All eight latest balanced ceilings remain
missed until Root repeats the comparison and obtains an accepted result.

## Preparation

From a clean Breezer checkout, after normal pinned Chromium/Helium source
preparation, use the existing hook on a private, quiescent source copy:

```sh
python3 script/apply_breezer_workspace.py "$CHROMIUM_SOURCE"
python3 script/apply_breezer_workspace.py --check "$CHROMIUM_SOURCE"
python3 script/apply_breezer_workspace.py --fingerprint
```

The normal build wrapper already calls this hook. Its workspace fingerprint
includes the baseline, payload and pins. Existing preparation markers therefore
refuse stale reuse before changing source or compiled output. Use a separate
build directory or Root's separately verified overlay migration. Do not delete
markers or compiled caches to bypass that check.

There is no separate scrollbar applier, marker or build-wrapper path.

## Offline regression

Python 3 and a local C++20 compiler with AddressSanitizer and
UndefinedBehaviorSanitizer are required. No download, app launch or native
browser build occurs. This check needs only tracked checkout files:

```sh
python3 script/check_breezer_hidden_scrollbar.py
python3 script/check_breezer_hidden_scrollbar.py --failure-controls
```

Reproduce the original failure with the same actual-method fixture:

```sh
python3 script/check_breezer_hidden_scrollbar.py \
  --source features/performance/hidden-scrollbar/baseline/rounded_scroll_bar.cc \
  --case hidden-bounds
```

The baseline must exit 1 with `BOUNDS/OPACITY still active`. The default payload
must pass all cases. `--output DIRECTORY` retains extracted C++, source hashes,
compile commands and run logs. Failure controls deliberately omit each required
stop, move the timer stop after callbacks, remove the animator reference and
replace the narrow stops with a global stop. Each must fail its targeted case;
the missing-reference control must report a sanitizer use-after-free.

The fixture inserts the actual bounds, Show, Hide, countdown, size-animation and
mouse enter/exit methods verbatim. Controlled doubles model their lower-layer
API. It exercises final targets, unrelated transform preservation, idle and
visible behavior, size animation, reshow, scrolling, hover, pressed state,
repeated updates, reentrancy, layer detachment, owner detachment and destruction.
Preparation checks use the real workspace transformer/writer and verify exact
pins, idempotence, drift rejection, source scope, fingerprints and output-cache
preservation.

With the existing pinned upstream source cache available, also run:

```sh
python3 script/check_breezer_workspace.py --offline
python3 script/check_breezer_preparation.py
```

The workspace check covers the complete overlay, interrupted replay and donor
drift before any writes. It supplies this target from the licensed baseline in
the checkout and prepares other targets from the existing upstream fixture.

## Remaining validation

The doubles do not compile Chromium headers or model the native compositor,
sequence scheduling, widget hierarchy, DPI, accessibility, drag or fallback UI.
They do not prove browser-level safety when a caller continues after a view
destroys itself. Root owns native compilation, widget/GPU functional checks and
the original live loop. The local source review supports the callback lifetime
choice: `StopAnimatingProperty` retains itself per call, `Layer::SetAnimator`
clears the delegate on detachment, and progression checks for a missing delegate.
The callback's extra reference spans both calls.

The Thumb's implicit animations are separate property sequences. Chromium's
property-stop API completes a whole sequence that contains that property; this
patch does not change that API or claim isolation within arbitrary mixed-property
sequences created by future callers.
