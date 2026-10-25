# Address-bar suggestion controls

Breezer ports [Helium PR 471](https://github.com/imputnet/helium/pull/471),
by Jinwoo Lee, from commit `6df45b23f38807d9f3660f840d48ba520395e63f`.
The source and original patch digest are recorded in
[`features/omnibox/upstream.json`](../features/omnibox/upstream.json).
The port targets Chromium `156.0.8078.47` and the Helium commits in
`upstream.lock.json`.

Settings → Search engine gains an **Address bar** section with the existing
search-engine suggestions toggle and independent **Show browsing history**
and **Show bookmarks** toggles. Both new preferences default to enabled.
Turning history suggestions off leaves direct URL navigation available and
does not delete browsing history. The original `helium.omnibox.autocomplete.*`
preference keys are retained for compatibility.

## Review and adaptations

The original PR cannot apply unchanged to this source version. Breezer uses
the current Lit Settings template and `pref-key` bindings. Existing Helium
search-suggestion labels remain in place; only the four new labels are added.

The behavior review found that the original history URL provider permanently
changed its search flag when history suggestions were disabled. Turning the
toggle back on could leave suggestions disabled for the lifetime of that
provider. The port reads the preference on each request, after preserving the
typed URL fallback and before querying history. It leaves the experiment flag
unchanged. A suspected stale SearchProvider cache problem was ruled out by
tracing its result clearing; no cache workaround was added.

The compatibility review found that the provider test clients need the new
preferences registered. The shared fake now registers all omnibox profile
preferences once. Three existing duplicate registration sites move into that
initialization, and the bookmark mock gets a real preference service. Required
GN test dependencies are explicit. All existing test cases remain.

The port retains the PR's provider scope: bookmarks, quick/fuzzy/URL history,
local zero-suggest history, local search history, and learned shortcuts.
History-off also suppresses learned shortcuts. Optional history-cluster,
embeddings, and most-visited providers are outside this port; revisit their
preference handling if those currently disabled or gated features are enabled.

## Build integration contract

The patch lives outside the imported source:
[`features/omnibox/omnibox-suggestions.patch`](../features/omnibox/omnibox-suggestions.patch).
Do not change `upstream/` or fold this overlay into the AI preparation marker.

After base, branding, and AI preparation, before GN generation, run:

```sh
python3 script/apply_breezer_omnibox.py "$SOURCE_TREE"
python3 script/apply_breezer_omnibox.py --check "$SOURCE_TREE"
python3 script/apply_breezer_omnibox.py --fingerprint
```

The separate fingerprint includes exactly these files:

- `script/apply_breezer_omnibox.py`
- `features/omnibox/omnibox-suggestions.patch`
- `features/omnibox/upstream.json`

The build wrapper owns a separate marker. Write it only after apply and check
succeed. A matching marker still requires `--check`. A verified base+AI tree
without an omnibox marker can receive this first overlay while retaining its
compiled output. Application is idempotent and can finish an interrupted update
whose individual files are wholly old or wholly new. Unknown anchors fail
before any real source is written.

**Changed or removed overlay inputs require fresh base preparation.** The
applier deliberately does not remove old targets or hunks. If an existing
omnibox marker differs from the current fingerprint, the wrapper must stop and
request a fresh prepared source tree. Running the new patch and `--check` alone
does not prove that retired changes are absent. Never reuse an overlay-bearing
cache as a markerless base cache, and never change the AI marker to hide an
omnibox upgrade. Removal likewise needs fresh base preparation.

New labels are in the existing settings group in `settings_strings.grdp`.
No omnibox patch target overlaps the AI overlay; its final message in
`generated_resources.grd` remains next to `</messages>`.

## Verification

```sh
python3 script/check_breezer_omnibox.py
python3 script/check_breezer_omnibox.py --offline \
  --grit-directory build/branding-check/tools/grit
```

The second command requires the pinned GRIT checkout and cached source files.
The checker fetches only needed Chromium files into a versioned cache under
`build/omnibox-check`, applies both pinned Helium patch series in a temporary
tree, and checks the actual overlay alongside AI preparation. It verifies
idempotence, read-only checking, interrupted-file recovery, no source writes
on an unknown anchor, and preservation of original test cases. With GRIT it
also runs Breezer string branding and compiles all four labels, checking their
generated IDs and packed text.

These checks passed locally on macOS with Apple patch 2.0-12u11. The patch adds
native regressions in `BookmarkProviderTest`, `HistoryURLProviderTest`, and
`SearchProviderTest`, plus `SearchPageTests.BreezerLocalSuggestionPreferencesAreIndependent`.
Native tests cover disable/re-enable behavior and typed URL navigation; the
WebUI test checks the actual preference writes and independence of controls.

The native C++ and Chromium WebUI tests have **not** run yet. Neither browser
behavior nor its Settings layout has been verified in a compiled Breezer build,
so no runtime screenshot is available. Run the affected provider suites in
`components_unittests`, `SearchProviderTest` in `unit_tests`, and the Settings
SearchPage WebUI suite after compilation. Preserve the active native build;
apply this overlay on its next prepared-source integration.

The adapted patch and scripts were written by GPT-6 Astra. GPT-6.1 Sol High
reviewed the port, native test fixtures, and overlay behavior. Earlier review
of the original PR used GPT-6 Luna; no Luna-authored code is in this port.
