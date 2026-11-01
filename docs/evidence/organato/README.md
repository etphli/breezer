# Organato off and setup opt-out evidence

Captured in headless Chrome against `chrome.*` page fixtures (no native Breezer build, no Organato account). Sites and items are test data. Images were downscaled for the repository.

- `before-off-light.png`: the previous new tab with `enabled: false` (from the code before this change): the full sheet, heading, Refresh and an "Organato is turned off" card.
- `after-off-light.png`, `after-off-dark.png`, `after-off-narrow.png`: the same "off" answer (still carrying cached items and an error) now shows only the date and shortcuts. Captured by `tests/ai/newtab-browser.test.mjs`.
- `reenabled-loading.png`: an open new tab after Organato is switched back on elsewhere, loading before the lanes return.
- `onboarding-optout.png`: the Organato setup step with **Don’t use Organato**.
- `onboarding-optout-failed-narrow.png`: a failed save at 390 px; Organato stays on and setup stays on this step.
- `onboarding-summary-off.png`: the summary after opting out. Captured by `tests/ai/onboarding-browser.test.mjs`.
