# Breezer design review: rendered UI

## Overall score: 8.5 / 10

Breezer looks like a calm, well-considered product. Setup, the new tab, the release page and the translation window are its strongest areas. It falls short of top-tier mainly on small repeated flaws, not structural ones:
- off-axis alignment in the compact sidebar
- low disclosure arrows
- browser colours that don't match the app in some themes
- action and status hierarchy in recovery states
- abrupt state changes

## Scores

Native scores are based on real macOS windows from a private verification build. It used the retained Chromium 156 core, freshly compiled frame/workspace/avatar UI and the current web UI. It is not a release build. **Limit** marks an evidence limit; everything else in the table was observed.

| Category | Score | Why it fell short of 10 |
|---|---:|---|
| Hierarchy | 8.8 | Status text often sits far from its action; Assistant's save and destructive actions sit in one row; muted notes sometimes outrank nothing |
| Typography | 8.7 | Monospaced text looks foreign in two places; body grey varies on the release page; some illustration labels are tiny on narrow screens |
| Alignment | 8.2 | Compact sidebar space tile is off the icon axis; expanded disclosure arrows sit low; the article has three competing right edges |
| Spacing | 8.6 | Intro-to-card gap is tight on Spaces; tab-title space goes unused; popover overlaps feel tight |
| Rhythm/density | 8.6 | Saved-key and Assistant settings get long; expanded release details become text walls |
| Consistency | 8.1 | Near-duplicate "Browser settings" names; pill buttons on the release page only; selected space chips differ; focus rings differ between lists and rows |
| Craft/polish | 8.2 | Stacked tile-in-tile icons; hard text clip while working; tab menu covers its own row; small text-width shifts in segments |
| Color across modes | 8.3 | Graphite browser frame is blue, not neutral; custom colour shifts far from its swatch; custom dark card goes neutral on a blue page |
| Contrast | 8.4 | Dark disabled Translate almost blends in; Assistant textarea values read like placeholders; Graphite's dark primary button looks semi-disabled |
| Navigation | 8.4 | Three names for browser settings; sidebar toggle appears twice in the window; "Coming up" has no obvious link back from the article's end |
| Sidebar | 8.0 | Compact tile misaligned; "New tab" action and New Tab page row look alike in dark; titles truncate early; two plus icons in the rail |
| Settings/controls | 8.5 | Disabled controls don't explain themselves; dependent toggles stay on with no key; "Update helper" and "native sync" are jargon |
| Assistant | 8.3 | Three stacked status rows while working; loading page gives no state; unlabelled pointer icon; unsubjected tooltip; terminal-only sign-in |
| New tab | 8.6 | Date colours are unexplained; only undated to-dos show a completion circle; shortcut block is misaligned on phones; card hard-cuts at fold |
| Responsive layouts | 8.7 | Narrow settings action rows wrap unevenly; lone "Add shortcut" is orphaned; picker list cuts off with no fade |
| Custom UI motion | 8.0 | New tab swaps content abruptly and jumps height; source picker scrim pops; active tab highlight trails the space change. **Limit:** frames only |
| Empty/error states | 8.3 | Retry appears above the reason; "wait" gives no countdown; Assistant error has no plain retry; partial failure stacks two loud pink blocks |
| Keyboard/focus appearance | 8.4 | Thick ring crosses dividers in Model options; list and row rings differ; several ring styles. **Limit:** static focus states only |
| Onboarding | 8.9 | Headline height shifts between steps; too many exits on Organato; import status sits far from its button |
| What's New | 8.8 | Repeated "Details" labels; dense expanded disclosures; "See full results" and "Full results" overlap; low arrow when open |
| Efficiency article | 8.7 | Text, table and rule end at different widths; typewriter face; "ms" repeats in every row; no way back at the end |
| Translation window | 8.7 | Retry sits above its reason; two "secondary" links compete; dark unchecked boxes turn off-palette grey. **Limit:** native window and bridge unverified |
| Native top tabs (compiled runtime) | 8.3 | Saturated tab dividers in light themes; active tab is subtle in dark; Graphite and custom frames read as Tide. **Limit:** hit-testing unverified |
| Native toolbar/window controls (compiled runtime) | 8.1 | Centered address leaves its icons stranded; sidebar and toolbar darks differ at the seam; the bookmark row shows a lone icon; Graphite tint is wrong. **Limit:** auto-hide reveal unverified |
| Observed native UI motion (compiled runtime) | 8.0 | Sampled frames settle cleanly, but widening or closing is not visibly resolved between samples. **Limit:** decoded-frame judgment only; no playback, input latency or frame pacing |

## Necessary fixes
1. **Compact sidebar:** put the space tile on the same centre line as the icons below it, in both the document and the native window.
2. **Disclosure arrows:** align the open arrow with its label wherever it drops: password guide, setup guide, signed-out instructions and release details.
3. **Graphite and custom browser frames:** make Graphite truly neutral in both modes, and make custom frames follow the chosen hue.
4. **Custom colour:** bring the UI accent closer to the swatch. Tint the dark card to match its page, and stop the selected outline looking like a stuck focus ring.
5. **Recovery order:** put the reason before Retry. Translation rate limits need a wait time or a temporarily disabled Retry, and the Assistant error needs a direct retry.
6. **Assistant while working:** merge the status lines, add a fade above the composer, and show a clear page-loading state.
7. **Assistant settings:** separate "Save choices" from "Disable and erase", and darken saved textarea text.
8. **New tab loading:** reserve card height, or crossfade, so content doesn't jump when it loads.
9. **Names:** resolve "Browser settings", "All settings" and "All browser settings"; replace "Update helper" and "native sync"; and give the repeated release "Details" links distinct labels.
10. **To-do affordance:** show completion consistently on dated and undated to-dos.
11. **Verify one new-tab state:** after adding a shortcut, the Organato card ends flat and a second settings icon appears below it. This looks like a capture seam, but I could not confirm that.

## Optional taste
- Remove the inner tile from favourites and monogram icons.
- Tone down tab dividers in light themes.
- Soften the neutral grey scrim with a slight palette tint.
- Reduce the pink in partial failures to one calm notice with a coloured edge.
- Replace the typewriter face with the UI mono font.
- Match the article's table width to its text column.
- Use one rounding language for release-page and app buttons.

## Satisfaction and blockers
I am satisfied with the overall direction, but I would not call it finished yet.

- **Before sign-off:** fixes 1–3 and the new-tab check in fix 11.
- **Blocking functional failures:** none observed. No screen was unusable, and I saw no text overflow or illegible state in the states inspected.

## Coverage and limitations
- **Fully shown:** all 14 palette sheets; the 44 Mint settings captures plus Mint enabled Assistant; Mint setup, assistant and model options at 320px and narrow widths, with representatives from each other palette.
- **Workflows shown:** the listed workflow captures, all 28 translation palette captures, all eight sharing and error states, both 320px translation captures, and all 12 motion sheets.
- **Native shown:** all native sheets, all 28 top windows, all toolbar and sidebar-frame states, and the system-mode window. Both native manifests and motion-frame records were read.
- **Sampled, not fully opened:**
  - Release-page and most article tiles: judged from the sheets, focused captures and three article tiles. The tall narrow results image was too small to judge, so I used its table detail capture.
  - The 48 timed motion images and most raw video frames: three video frames were opened raw.
  - Native frames: normal start, 600, 1500 and 1800, and reduced start, 600 and 1500 were opened raw; the rest came from sheets.
  - Other palettes' settings: reviewed on sheets, except custom Appearance.
- **Trimmed images:** image blocks from many early batches are no longer in my context, so those findings rest on my private ledger notes and I could not re-check them.
- **No playback:** no video player or decoder was available, so all motion judgments come from decoded frames. They say nothing about smoothness, input latency or frame pacing.
- **Unverified:** macOS menus, physical hit-testing, restoration, physical auto-hide, the translation window's native geometry and bridge, and real provider inference.
- **Unresolved:** the reduced-motion native run shows neutral grey browser chrome rather than Mint dark. The settings for that run may explain it, so I have not counted it as a flaw.
- **Contrast:** judged by eye, plus a few sampled pixels and the recorded translation button ratios. This was not a full accessibility audit.
