# Breezer UI design review: round 15 evidence

## Overall score: 8.7 / 10

Breezer is a calm, coherent, professional product. Its themes hold up, its error states are honest, and its release page has real editorial character. It isn't finished at the top level yet: four small visible defects remain, and the action hierarchy is weakest wherever several kinds of control share one card. None of these breaks a core task, but a professional reviewer would catch all four.

## Scores

Native scores use the private UI verification build, not a release rebuild: a retained Chromium 156 core reporting Breezer 0.20.1.1, with current UI units and all 50 web resources hash-verified. Native windows were judged from saved stills, and native motion from decoded frames only.

| Category | Score | Why it fell short of 10 |
|---|---:|---|
| Hierarchy | 8.6 | In Assistant settings, Save stays loudest even with memory off. In running translation, the disabled main button outweighs Stop. |
| Typography | 9.0 | Serif and sans pairing is strong. Long helper lines leave one-word last lines, and setup's name field uses a larger text size than other fields. |
| Alignment | 8.8 | The import card's text sits further in than the setting rows below it, so left edges don't line up. New-tab content jumps sideways between states. |
| Spacing | 8.4 | Efficiency footer buttons touch on desktop. The Spaces intro nearly touches its card. |
| Rhythm/density | 8.6 | Settings rows change height with and without descriptions. Sparse pages leave most of the screen empty. |
| Consistency | 8.3 | Dark settings dropdowns lose their arrow, while the translation window keeps it. Dark dropdowns and text fields disagree in the same card. |
| Craft/polish | 8.3 | What's New clips the focus ring and button shadow. Sidebar favorites put a box inside a box. |
| Color across modes | 9.0 | Palettes are disciplined. Dark selected options feel heavier than light ones, and the custom dark model row is the weakest selection. |
| Contrast | 8.8 | Inactive favorite labels are faint in light mode, and disabled "Reload languages" is very pale. Observed by eye only. |
| Navigation | 8.8 | The settings nav lists both "Browser settings" and "All browser settings". Sidebar toggles are duplicated in one window. |
| Sidebar | 8.5 | Two identical toggles and, in the compact rail, two identical plus icons. Inactive titles shorten early, as if a close button were present. |
| Settings/controls | 8.2 | Missing dark dropdown arrows, a disabled Disconnect always beside Connect, and instant toggles mixed with explicit Save in Assistant. |
| Assistant | 8.9 | Two metadata rows above the composer use scarce height. At 320px, the model popover cuts through a suggestion line. |
| New tab | 8.3 | The agenda appears in one hard cut. With Organato off, the date moves left and leaves the right half empty. |
| Responsive layouts | 9.0 | Reflow is strong. The narrow source picker clips its list with no fade, and the narrow new tab leaves Add shortcut alone on a row. |
| Custom UI motion | 8.6 | Decoded frames: the source dialog pops in, and the active tab highlight lands after the space change. Pacing unverified. |
| Empty/error states | 8.9 | Failures are clear and calm. Refresh stays disabled in new-tab setup and loading, and new-tab error repeats its instruction. |
| Keyboard/focus appearance | 8.4 | The What's New focus ring is cut flat. The model-options ring crowds its neighbours, and the model menu ring touches the selected row. |
| Onboarding | 8.9 | Import status sits far from its button, the import stage runs slightly over the viewport, and the progress bar vanishes during tips. |
| What's New | 8.9 | The clipped masthead ring and shadow are the main flaw. "Performance measurements" is a big heading over one closed disclosure. |
| Efficiency article | 8.7 | Footer buttons touch on desktop, and the candidate column isn't emphasized. "Process-tree RSS" stays unexplained until the method notes. |
| Translation window | 9.2 | Disabled Translate looks like a live secondary button, especially in light mode. The running state favors the wrong action. |
| Native top tabs *(compiled build, stills)* | 9.0 | The selected tab's title fades earlier than unselected ones. Tab separators are slightly bright in Mint and Pollen light. |
| Native toolbar/window controls *(compiled build, stills)* | 8.8 | The empty bookmarks row spends height on a lone Apps icon. Frameless options look identical at rest. Physical hit testing unverified. |
| Observed native UI motion *(compiled build, decoded frames only)* | 8.8 | The closing tab and sliding plus button stayed coherent in sampled frames, but evidence is too sparse to score higher. Playback, latency and pacing unverified. |

## Necessary fixes

1. **Dark settings dropdowns:** restore the arrow on the Spaces color control and the translation provider control. Seen in Mint and Rose dark at both widths where captured, and the translation window shows the correct treatment.
2. **What's New masthead:** stop the band below the buttons from clipping the Open Settings focus ring and the Continue browsing shadow.
3. **Efficiency footer:** add a real gap between "Full benchmark results" and "Back to the update log" on desktop. Narrow stacking also needs more space.
4. **Import copy:** "The steps are in Passwords below" points to nothing below on the page. Replace it with a reference to the Show password steps button.
5. **Duplicate controls:** keep one sidebar toggle per window. In the compact rail, make the two plus icons visibly different in meaning.
6. **Translation running state:** make Stop the clear action while the wide disabled button recedes.
7. **Disabled Translate page:** make it read as unavailable, not as a working secondary button.
8. **Assistant settings actions:** tie Save to the field it saves, and quiet it while memory is off.
9. **New-tab states:** keep the date in one position across Organato on, off and loading. Replace the loading card's hard cut with reserved agenda space or a quiet crossfade.
10. **Import card padding:** match its inner padding to the setting rows below.

## Optional taste improvements

- Merge or better separate "Browser settings" and "All browser settings".
- Tighten the assistant's page chip and "Page + screenshot" caption into one row.
- Give the source-tab dialog the same short entrance as other surfaces.
- Show a title hint in the favorite tile instead of the inner letter box.
- Highlight the candidate column in efficiency tables, and put units in a shared caption.
- Add a one-line result under "Performance measurements" before its disclosure.
- Show the version and a release-notes link beside update availability.
- Add a copy button to the account setup command.
- Hide or remove the bookmarks row when it's empty.
- Use a stronger selected state for custom dark model rows.

## Satisfaction

I'm satisfied with the direction and overall product quality, but not with this as a finished state. The 10 necessary fixes above are the remaining blockers. Fixes 1–5 are small and should close the most visible gaps.

## Coverage and limitations

**Fully inspected:**
- All 14 core palette sheets.
- All 44 Mint settings images plus the Mint enabled Assistant states.
- Mint setup, assistant and model options in both modes.
- Narrow setup and 320px assistant for the other six palettes.
- Custom-theme selection states.
- All 28 translation palette images, all 8 before-sharing and error images, and the two 320px images.
- All 12 motion sheets and `motion.json`.
- All 28 native top windows, all toolbar and sidebar-frame states, the plus-button samples, and the native manifests.

**Partly inspected:**
- Model options from the remaining palettes: raw images for custom dark, Pollen dark narrow and Rose light. Tide, Dusk and Graphite came from sheets only.
- What's New: all three sheets, but only some raw tiles. Most narrow and expanded tiles were judged from sheets.
- Efficiency: narrow tiles 2–5 were judged from their sheet plus focused captures.
- Native motion frames: sheets for all sampled times, but raw frames only for start, 600 and 1500 in normal mode, and start and 1500 in reduced mode.
- Motion raw frames: only two Spaces frames at raw size.

**Not established:**
- I did not play any WebM or MP4 recording, so every motion judgment is from decoded frames and animation records.
- Frame pacing, input latency and smoothness can't be established from this evidence. The new-tab cut timing comes from fixture delay.
- Unverified: physical mouse hit testing, macOS menus, restoration, physical auto-hide, translation native geometry and bridge, and provider execution.
- Contrast judgments are visual, apart from the recorded translation action contrast values.
- Fixture content can affect sparse states, such as the single space and empty bookmarks row.

**Excluded as capture artifacts:** the fictional page body, the recording badge, black corners in the native video frames, and the sticky bar inside the tall results capture (raw tiles show it correctly placed).

Exact evidence references are in my private coverage ledger.
