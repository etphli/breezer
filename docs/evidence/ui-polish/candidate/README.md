# Candidate evidence

Current evidence for the twelfth UI refinement. It has not received a council
score. GPT-6.1 Sol wrote the refinement and capture tools. All work remains local.

- `screens/` contains Mint settings and selected workflows, all translation
  palettes/modes, before-sharing/error states and the repaired narrow captures.
- `matrix/` indexes 490 matching-source captures in 14 sheets. Its manifest
  records all 50 UI source hashes. Use raw captures to judge small details.
- `motion/` retains twelve original custom-UI recordings and decoded-frame
  sheets, including all six reduced-motion checks. Sampling does not measure
  frame pacing.
- `native/` has 39 genuine full-window captures and two continuous MP4s. Its
  README states runtime provenance and the remaining native unknowns.
- `comparisons/candidate-12-*.png` shows twelve annotated before/after pairs.
  Historical comparisons are retained under their original names.
- `checks/verification.json` records 545 distinct passing checks, two explicit
  skips and zero unresolved failures across resumed batches. The 337-check prefix
  was interrupted at a complete file boundary; remaining files ran separately.
  A new update-timeout regression reproduced the hidden recovery action and
  passed after its fix. Both assistant/research walkthroughs and the final
  settings walkthrough passed. Four offline native-source checks passed separately.
- `evidence-hashes.json` identifies all included artifacts.

Translation uses one grouped form with required sharing consent ahead of optional
automatic translation. Model choices precede advanced options. Assistant activity
is quieter, its tooltip points to browser control, and the six-source limit is
visibly enforced. Update news leads one available-update action, key removal is
direct and destructive, and Organato errors sit beside the failed action. Narrow
setup navigation fits at 320px. The Organato illustration remains.
Clicking the saved-key row heading preserves the key; only the removal button
activates that action. This is checked in the real browser walkthrough.

All 36 translation images pass stable-frame, single-heading and empty-area paint
guards. Narrow profile and model-option captures require stable CSS-pixel PNGs
and matching surface paint; a recorded corrupt profile PNG is a negative control.
The 9.5 threshold remains unmet. No new council or replacement reviewer was started.
