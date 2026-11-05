# Candidate evidence

Current evidence for the fourteenth UI refinement, awaiting its council review.
GPT-6.1 Sol wrote the code and verification tools. All changes remain local.

- `screens/` contains selected current settings, assistant, setup, release and
  translation states, including the expanded import guidance.
- `matrix/` indexes 490 matching-source captures in 14 palette/mode sheets. The
  manifest records all 50 UI source hashes.
- `motion/` retains twelve custom-UI recordings and decoded-frame sheets, with
  all six reduced-motion assertions passing.
- `native/` contains 39 fresh native windows and two continuous recordings of
  the private current-UI verification build. Its README explains the retained
  Chromium core, newly compiled UI units and remaining limits.
- `comparisons/candidate-14-*.png` shows eleven actual annotated before/after
  pairs. Earlier comparisons retain their original names.
- `checks/verification.json` records 547 tests, 545 passing, zero failures and
  two explicit skips, followed by successful assistant and research walkthroughs.
- `evidence-hashes.json` identifies all included artifacts.

Browser control now sits beside its page source, with the tooltip anchored to
that trigger. The composer has fewer controls. General settings keeps import
buttons visible and puts longer instructions behind a disclosure. Layout helper
copy is shorter. Release summaries keep their reading width when details expand.

The native placeholder profile icon uses the toolbar foreground, retaining
profile photos and special-state artwork. Actual PNG stroke/background samples
measure 8.84:1 or higher in all fourteen palette/mode states. The resting auto-hide
edge no longer exposes slices of sidebar controls. Native inputs, compiled
objects, retained core data and all fifty loaded UI resources have recorded
hashes. The installed app and real profile remain unchanged.

The native build is for UI verification, not a full product or release rebuild.
Motion samples do not establish frame pacing, smoothness or input latency.
Physical hit testing, menus, restoration, physical auto-hide, translation native
geometry/bridge and provider execution remain unverified. The 9.5 threshold
remains unmet; PR #17 has not been pushed or updated.
