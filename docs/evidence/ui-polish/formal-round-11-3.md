# Breezer design review: rendered UI

**Overall score: 8.8/10**

The observed UI is professional, calm and consistent across all palettes and both modes. I found no broken product state, only small hierarchy and state-clarity defects. Two captures are faulty, and one of them leaves the narrow profile dialog unassessed.

## Category scores

| Category | Score |
|---|---:|
| Hierarchy | 8.8 |
| Typography | 9.0 |
| Alignment | 8.8 |
| Spacing | 8.8 |
| Rhythm/density | 8.7 |
| Consistency | 9.0 |
| Craft/polish | 8.8 |
| Color across modes | 9.1 |
| Contrast | 9.0 |
| Navigation | 8.8 |
| Sidebar | 8.9 |
| Settings/controls | 8.8 |
| Assistant | 8.8 |
| New tab | 8.9 |
| Responsive layouts | 8.7 |
| Custom UI motion (decoded frames and metadata only) | 8.3 |
| Empty/error states | 8.7 |
| Keyboard/focus appearance | 8.9 |
| Onboarding | 9.0 |
| What's New | 9.3 |
| Efficiency reference article | 8.9 |
| Translation window | 8.4 |
| Native top tabs/toolbar | Unverified, not scored |

## Necessary fixes

**Evidence first (not established as product defects):**

1. **`sidebar-profile-dialog-narrow.png`:** the image repeats a tile about 500×553 device pixels across and down the frame. The form's lower half and its Save action can't be seen, so recapture it.
2. **`tide-dark-assistant-options-narrow.png`:** the panel is cut off at about y=553, and the Breezer header repeats below it. `tide-light`, `dusk-dark`, `rose-light`, `pollen-light`, `graphite-dark` and both Mint captures of the same screen were clean. This is probably a capture fault, but I haven't confirmed that, so recapture it.

**Product:**

3. **`onboarding-6-organato-optout-failed-narrow.png`:** "Couldn't turn Organato off" sits above the divider, next to Connect, while the action that failed is below it. Move the error to the "Don't use Organato" button.
4. **`newtab-error.png`:** with no shortcuts, the "Add shortcut" label is about 10px off-center from its tile. Every other state centers it.
5. **`sidebar-control-tooltip.png`, `sidebar-control-tooltip-narrow.png`:** the tooltip sits at the left of the panel, about 230px from its trigger, with no pointer. Anchor it to the trigger.
6. **`research-picker.png`:** at 6 of 6 selected, the unchecked "Extra article 4" row still looks selectable. Give it a visibly disabled state.
7. **`settings-update-available-light.png`, `settings-update-available-narrow.png`:** "Breezer 1.1.1 is available." appears last, outside the card and below the actions. "Check for updates" also stays beside "Update and restart". Lead with the news and remove the redundant action.
8. **`settings-translation-saved-key-light-narrow.png`:** "Remove saved key" is a destructive action styled as an ordinary checkbox among the toggles, and it only applies on Save. Use a clearly destructive action.
9. **`sidebar-error-narrow.png`:** the raw "CLI test rejection" text is exposed, and "Edit and resend" is the only recovery. If real provider errors surface this way, they need plain wording. The text may come from the fixture.
10. **`newtab-narrow.png`:** the shortcut grid starts at about x=65 while the heading starts at about x=24. Align them, or center both deliberately.

## Optional taste improvements

- **Hierarchy:**
  - `efficiency-desktop.png`: the bold serif "What changed" outweighs the regular-weight title. Lighten it or use one heading voice.
  - `translation-error-light.png`: Retry is outlined, but it is the primary action at that moment.
  - `translation-mint-light.png`: consider merging the sharing checkbox, private-text note and disclosure into one consent group.
- **Typography:**
  - `whats-new-results-expanded.png`: "Restoring saved-tab records" is vertically centered while "First local page" is top-aligned. Top-align both.
  - `mint-light-settings-newtab-narrow.png`: "to-/dos" breaks across lines, so add a non-breaking hyphen.
- **Data clarity:**
  - `efficiency-browser-table-desktop.png`: regressions such as 48.9 and 2,756.1 aren't marked. The "ms" unit also repeats in every row and could move to the caption.
  - `whats-new-results-expanded.png`: the first chart leaves out Chrome's 52.4 ms, though the prose states it. Adding the bar would be more candid.
- **Spacing:**
  - `onboarding-1-welcome.png` through `onboarding-5-import.png`: the heading jumps vertically between steps. A fixed top anchor would be steadier.
  - `mint-light-settings-languages-narrow.png`: the provider controls stop short of the card edge, while "Save choices" on the Assistant page is full width.
  - Narrow settings pages: "Setup guide" may overhang the content edge by about 4px. I estimated this by eye and did not measure it.
- **Restraint:**
  - `mint-light-onboarding.png`: three decline paths compete on the Organato step (Skip setup, Don't use Organato, Not now).
  - `newtab-add-popover.png`: the double focus outline is heavy.
  - `settings-redesign-search-light.png`: results repeat their heading and subtitle.
- **Craft:**
  - `mint-light-settings-assistant-enabled.png`: the Activity summary card has no row dividers, unlike its sibling cards.
  - `custom-light-settings-appearance.png`: the custom theme's selected ring is clear, but it sits awkwardly on one row of a grouped card.
  - `newtab-organato-off-light.png`: the composition feels left-heavy at wide widths.
- **Motion:**
  - `sheet-newtab-no-preference.png`: skeleton to content is a hard swap, and the card height jumps. A short fade would help.
  - `spaces-no-preference-video-0.png`: a generic "Space" placeholder shows before Work loads. It is present in both motion modes, in frames decoded from the recordings.

## Satisfaction and blockers

I'm satisfied with the overall observed design. **No product design blockers are confirmed.** I wouldn't give full sign-off until the two faulty captures are retaken, because the narrow profile dialog is unassessed and the Tide dark model options need a clean capture. Fixes 3–8 are small and worth doing before release.

## Coverage

**Fully opened:**
- All 14 core sheets.
- All 48 Mint settings captures.
- Mint assistant, options and setup at both widths and in both modes.
- Narrow setup and assistant samples for every other palette, plus options samples.
- Custom theme selected state in both modes.
- All three What's New sheets and both efficiency sheets.
- Both translation sheets and all 36 translation raws (28 theme, 8 state).
- All 12 motion sheets and `motion.json`.
- The named workflow captures, with these exceptions: `settings-redesign-layout-narrow.png` and most other `settings-redesign-*` variants weren't individually needed, and `whats-new-results-narrow.png` and `whats-new-results-full.png` weren't opened.

**Sampled only:**
- Raw motion frames: 3 of 144, namely `spaces-no-preference-video-0.png`, `spaces-no-preference-video-150.png` and `settings-no-preference-video-100.png`. The rest were seen on sheets.
- The 48 locator-settled timed PNGs were not opened.
- What's New tiles: `whats-new-expanded-desktop-tile-04.png`, `whats-new-expanded-desktop-tile-12.png` and `whats-new-narrow-tile-10.png`, plus the focused captures.
- Efficiency tiles: desktop tiles 02–04. Narrow tiles were read from the sheet plus the focused captures.
- Efficiency tiles and table captures all rendered without defects at readable size.

**Limitations:**
- WebM recordings were not played, so I make no claim about smoothness, frame pacing or input latency. Motion scores rest on decoded frames and `motion.json` only.
- Many earlier images left my context, so some findings come from my ledger notes. Pixel offsets are approximate unless the fix says otherwise.
- My repeated-band scan across all core and workflow captures did not finish (exit 120). The header check on the 42 assistant-named captures flagged only item 2, so the similar fault in item 1 was found by eye and others could exist.
- These are fixture renders, so no provider or inference behavior is established. The translation window's native geometry and bridge remain unverified.
- **Unverified and unscored:** native top tabs, native toolbar, macOS window and menu integration, physical auto-hide and native animation.

**Environment:**
- My scan's BMP copies (about 1.13 GB, in my own temporary folder) contributed to a disk-full error partway through. I deleted those two folders. Evidence file counts are unchanged at 505 and 253.
- The disk still has only about 1.1 GB free, which may affect the timing work.
- I ran no browser, test, build or playback during the hold, and I own no runtime job.
- My ledger remains at `/tmp/breezer-review-ledger-pE7BdSUJ/ledger.md`.
