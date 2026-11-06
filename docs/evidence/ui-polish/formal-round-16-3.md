# Breezer design review: current rendered UI

**Overall score: 8.3 / 10.** Breezer looks like a calm, cohesive professional product. It falls short of top-tier polish because of repeated small issues: inconsistent save placement, weak recovery states, heavy focus rings and a few rough transitions.

**Review limitation:** many image blocks from the early passes were no longer available when I wrote this. That covers the palette sheets, Mint settings, assistant options, new tab, sidebar, research, dialogs, settings states, onboarding and part of What's New. Findings for those areas rest on notes I took at the time, and I did not reopen them to re-verify. Those scores are therefore less certain than the translation, efficiency and native scores.

## Scores

| Category | Score | Why it fell short of 10 |
|---|---:|---|
| Hierarchy | 8.5 | Some disabled, save and danger actions carry the same weight, and supporting warnings are too quiet. |
| Typography | 8.6 | Row labels vary in weight, and long small-type explanations feel dense in settings and technical notes. |
| Alignment | 8.4 | Text starts drift a few pixels in menus, the lone add tile is out of line, and the compact rail has an off-centre dash. |
| Spacing | 8.2 | Gaps between intro text and cards vary, a status message pushes content down, and setup leaves large empty bands. |
| Rhythm/density | 8.2 | Dense explanation blocks sit beside very sparse screens, so pacing is uneven. |
| Consistency | 8.0 | Save placement, button width, disclosure icons and error treatments differ by screen. |
| Craft/polish | 8.2 | Double focus rings, unequal Copy rows and leftover separators undercut otherwise careful work. |
| Color across modes | 8.6 | Dark fields are styled inconsistently, selected states are heavier in dark mode, and light tab separators are too saturated. |
| Contrast | 8.4 | Disabled links and buttons get very faint in dark mode. |
| Navigation | 8.6 | Settings navigation is clear, but the tab menu covers its own row. Physical navigation is unverified. |
| Sidebar | 8.5 | The two-letter tile is cramped, and the compact rail has a stray dash and a tall footer stack. |
| Settings/controls | 8.2 | Save patterns are mixed, three disabled buttons look alike, and one explanation says "here" on the wrong page. |
| Assistant | 8.4 | Raw source codes appear in research, and the command wraps in the account dialog. Provider behavior is unverified. |
| New tab | 7.9 | Loading leaves a large blank sheet, the layout without Organato feels top-heavy, and to-do markers are inconsistent. |
| Responsive layouts | 8.6 | Save buttons change shape between widths, and a lone add shortcut is stranded at narrow width. |
| Custom UI motion | 8.2 | The source dialog appears before the dimming, and the selected row lags during space switching (decoded frames only). |
| Empty/error states | 7.9 | Errors often restate the button instead of giving a next step, and treatments vary. |
| Keyboard/focus appearance | 8.0 | Rings are thick, doubled on inputs, and collide with remove buttons and dividers. |
| Onboarding | 8.3 | Three exits compete on the Organato step, the import step jumps, and the connected state lacks a success treatment. |
| What's New | 8.9 | Large headings sometimes lead to one collapsed row, and expanded details read long. Some raw tiles were reviewed on sheets only. |
| Linked efficiency reference | 8.3 | It is text-heavy, uses technical terms and an internal source path, and number alignment changes when narrow. |
| Translation window | 8.3 | The content floats at the top of an empty canvas, and the second checkbox is unexplained. Native geometry and the bridge are unverified. |
| Native top tabs* | 8.3 | Light separators are too bright, a separator sits by the plus button, and titles fade tightly at narrow width. |
| Native toolbar/window controls* | 8.4 | The centered address has a far-left info icon and uneven gaps, and the bookmarks bar shows a lone icon in this fixture. Settled window controls look fine. |
| Observed native UI motion* | 7.9 | Tab selection is a hard cut, the favicon squeezes against the separator during close, and the address jumps to centre. Judged from decoded frames only. |

*\*Native provenance: these are real windows from a private UI verification build. It uses the retained Chromium 156 core reporting Breezer 0.20.1.1, with shell metadata 1.2.0. It is not a full release build. Input latency, smoothness, frame pacing and physical interaction are not established.*

## Necessary fixes

1. **Use one save pattern in settings.** Assistant saves inside the card, while Translation saves below it with stacked status and link text. Width also changes between desktop and narrow.
2. **Make errors actionable.**
   - The new-tab error repeats its Settings button.
   - The Organato error gives no fix.
   - The update error says to choose the button it sits above.
3. **Clean up research results.** Replace the raw bracketed source codes with readable citations. Drop the red stripe on the rounded failure card and match the other error treatments.
4. **Give the new-tab agenda a real loading state.** Shortcuts have placeholders, but the agenda shows one line in a large blank sheet.
5. **Lighten focus rings.** Use one consistent ring that clears remove buttons, dividers and neighboring labels.
6. **Fix transition order.** The source dialog and its dimming should arrive together, and space switching should never show a frame with no selected tab. Confirm both in live playback first.
7. **Quiet the native tab separators in light themes,** and remove the one next to the plus button. Mint, Rose and Pollen stand out most.
8. **Remove the stray dash from the compact rail,** or centre it.
9. **Unify dark-mode fields.** Dropdowns and text fields currently use different fills and borders.
10. **Tidy the account and command rows.** Keep commands in a chip on one line where possible, and make Copy rows the same height.
11. **Stabilize the onboarding import step,** so opening it doesn't push the footer down or strand its status text.
12. **Fix the settings copy.** "Connect Organato to show your deadlines here" appears on a settings page, not where the deadlines appear.
13. **Replace the internal source path in the efficiency article** with a plain link or description.

## Optional taste improvements

- Use the same disclosure chevron in assistant errors as everywhere else.
- Anchor the lone new-tab shortcut and rebalance the layout without Organato.
- Move the tab menu so it doesn't cover its own row.
- Soften the outlined selected pill in dark mode.
- Give the password CSV warning more emphasis.
- Add a subtle selection transition to native tabs.
- Keep the efficiency tables' number alignment consistent when they stack.
- Use the same decimal precision on the release page and in the article.
- Vertically balance the translation content, or size the window to fit it.

## Verdict

I am satisfied that this is a strong, professional design, but not that it is finished. There are no release-stopping visual failures in what I observed.

**Remaining design blockers:** I would not call the design finished until these are fixed:
- Mixed save patterns
- Weak error recovery
- The new-tab loading state
- Heavy focus rings

The two transition issues should also be confirmed in live playback.

## Coverage and limitations

**Opened and displayed**
- All 14 core contact sheets and all 48 requested Mint settings captures, including enabled Assistant.
- Custom theme selected states, Mint assistant states and all 14 narrow model-options captures.
- Narrow setup and narrow assistant from every other palette.
- The new-tab, sidebar, research, dialog, settings-state and onboarding sets.
- Both translation sheets and all 38 translation captures.
- All efficiency close-ups and both of its contact sheets.
- All 12 motion sheets.
- All native sheets, all 28 native top windows, all toolbar and sidebar-frame states, and selected frame strips around selection and close.

**Partly covered**
- What's New: all three sheets, plus selected raw tiles and detail captures. Several tiles, three focused captures and the collapsed results state were not opened raw.
- Efficiency: the article was checked through its sheets and focused captures, not every raw tile.
- Motion: only 2 of the 144 video-derived frames were opened raw, and none of the 48 timed PNGs. Those assessments come from the sheets and timing records.
- Reduced native: judged from sheets, the start frame, the 1800 ms frame and two raw strips around close.

**Not established**
- I did not play the WebM or MP4 recordings, so all motion judgments are decoded-frame assessments. They do not establish smoothness, latency or frame pacing.
- Provider or inference behavior.
- macOS menus, physical hit testing, restoration and physical auto-hide.
- The translation window's native geometry and bridge.

**Excluded from judgment**
- The fictional page body in native captures.
- The recording-only title-bar badge.
- The third-party extension icon changing color.
- Fixture hosts and ports.

My private coverage ledger records the evidence behind each finding and everything left unopened.
