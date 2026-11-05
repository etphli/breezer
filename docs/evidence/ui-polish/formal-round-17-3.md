# Breezer design review: current rendered UI

## Overall score: 8.9 / 10

The product is calm, consistent and well organised across every palette and mode. What keeps it from a 9.5 is a set of small, repeated flaws: links and hints crowding their neighbours, one out-of-system link colour, content that jumps when something opens, and a few weak narrow-width edge cases.

## Category scores

| # | Category | Score | Why it fell short of 10 |
|---|---|---|---|
| 1 | Hierarchy | 9.0 | The setup screens offer several competing exits, and the Organato section of Settings and the efficiency intro give small notes more weight than they earn. |
| 2 | Typography | 9.0 | A shortcut label breaks mid-word, and the efficiency intro sets muted text above darker body text. |
| 3 | Alignment | 8.8 | "Skip setup" stops about 12px short of the Continue edge, and the Translation save note sits lower than its button. The update-note illustration is indented away from its heading. |
| 4 | Spacing | 8.6 | The Translation guide link nearly touches the card above it, and the Spaces intro hugs its card. Setup steps carry a large dead band above the footer. |
| 5 | Rhythm/density | 8.9 | What's New alternates tall illustrated sections with plain text sections, so its pace feels uneven. |
| 6 | Consistency | 8.7 | The Spaces name field looks different in light and dark. One article link uses browser blue, and command rows differ between the dialog and the sign-in card. |
| 7 | Craft/polish | 8.8 | Small misses are scattered through the product: the mid-word wrap, the blue link, the Copied button width, and the agenda jump. |
| 8 | Color across modes | 9.2 | The custom blue dark selected row is a little weaker than the presets. The custom color swatch stays green under other presets. |
| 9 | Contrast | 9.1 | Light-mode tab separators are faint in tinted palettes, and disabled Delete and dark disabled buttons sit close to their backgrounds. |
| 10 | Navigation | 9.2 | The settings list and section grouping are clear. The only drag is the three or four similar routes to Setup guide and Organato. |
| 11 | Sidebar | 9.2 | The compact rail is dense and two-letter initials take practice to read. The auto-hide reveal is an evidence limitation, not a flaw. |
| 12 | Settings/controls | 8.6 | The Translation and Spaces rows have visible layout and field flaws. Disabled Delete gives no reason, and some cards repeat their explanation. |
| 13 | Assistant | 8.8 | At 320px, sign-in instructions push "Refresh accounts" under the composer fade. Model options repeat the allowance message twice. |
| 14 | New tab | 8.8 | A long shortcut label wraps mid-word, and "Shortcut added." pushes the agenda down about 50px. The loading shape doesn't match the loaded list. |
| 15 | Responsive layouts | 8.8 | Reflow is solid down to 320px, except the sign-in card and some crowded button rows. Row labels wrap unevenly in the narrow article tables. |
| 16 | Custom UI motion | 8.8 | Decoded frames show agenda content hard-cutting from its loading state and the source panel showing before its backdrop. Motion is otherwise restrained, and reduced motion is immediate. This judgment rests on decoded frames, not smooth playback. |
| 17 | Empty/error states | 8.9 | Rate-limit and update errors repeat what the disabled button or the card below already says. Several states are otherwise clean. |
| 18 | Keyboard/focus appearance | 9.0 | Focus is clear, but the shortcut tile ring is large and bleeds past the text edge. The model options ring crowds the divider and label below. |
| 19 | Onboarding | 8.7 | The Skip link misses the right edge. The connected message is colored text in a white box, and tip screens drop the step progress bar. |
| 20 | What's New | 8.8 | Opening a detail section rebuilds the section above it, and illustrated and text-only sections feel uneven. Nesting in Measurements runs deep. |
| 21 | Efficiency reference article | 8.8 | The source link is default browser blue, the muted intro reads weaker than the text below it, and the two end buttons have equal weight. |
| 22 | Translation window | 9.4 | The geometry is identical in every palette, with no defect found. The error line and the retry label repeat each other, and native window geometry and bridge behaviour are unverified. |
| 23 | Native top tabs | 9.0 | The selected tab's title fades mid-word, and light-mode separators are faint. Active tab and address bar share one tint. |
| 24 | Native toolbar/window controls | 9.0 | The bookmarks bar shows a lone apps icon on an empty row. Settled frameless modes match the normal toolbar, so physical reveal cannot be judged. |
| 25 | Observed native UI motion | 8.8 | In encoded frames, selection changes in one step and normal close animates tidily. The centred-address change appears as an abrupt step between frames. Frame pacing and input latency are unverified. |

**Native provenance for categories 23–25:** these scores come from a private UI verification build on the retained Chromium 156 core, reporting Breezer 0.20.1.1, with verified current web resources. It is not a full release build. The judgment rests on still windows and decoded encoded frames, not physical interaction.

## Necessary fixes

These were all re-checked in raw captures.

1. **Efficiency article, Source row:** "Measurement report and methodology" is default browser blue. Use the same link color as the rest of the release pages.
2. **New tab shortcut labels:** a long domain breaks as "custom.exampl" / "e.com". Truncate it, or break at a sensible point.
3. **New tab "Shortcut added." message:** showing it pushes the whole agenda down about 50px. Reserve the space, or show it in place of the tile or as a transient toast.
4. **Translation settings:**
   - The LibreTranslate guide link sits about 7px under the card. Move it inside the card or give it proper section spacing.
   - Align "No API key saved." with the center of the Save button.
5. **Spaces settings:** the name field looks like plain text in light mode but has a visible fill in dark. Give both modes the same resting field. Also add normal gap between the intro text and the card.
6. **What's New detail sections:** opening "Startup and cleanup" swaps a text section for an illustrated two-column layout. The heading rewraps and the disclosure jumps down. Keep the layout stable and open content only below the control.
7. **Assistant sign-in instructions at 320px:**
   - "Refresh accounts" is faded and cut by the composer area, and in the copy-fallback state it drops out of view. Keep it reachable without hunting.
   - Fix the Copy button width so "Copied" doesn't narrow the command field.
8. **Setup header:** align "Skip setup" with the right edge of Continue and the illustration. Hold the step footer at one height, because the import state sits a few pixels lower.

## Optional improvements

**Hierarchy**
- Make the setup footer action stronger on steps where it competes with buttons in the content.
- Give the efficiency intro one voice.
- Make the last article buttons primary and secondary.

**Typography**
- Add a separator between adjacent source citations in research answers.
- Keep the selected native tab title readable where space allows.

**Spacing**
- Reduce the empty band on sparse setup steps.
- Tighten the loose gaps between password disclosures.
- Hide or reposition the bookmarks row when it holds only the apps icon.

**Restraint**
- Remove repeated copy:
  - The two allowance lines in model options.
  - The instruction in the new-tab error that repeats its button.
  - "Wait before retrying" beside "Retry in 30s".
- Drop "for one account" when only one route is needed.
- Avoid button-plus-underline styling on the new-tab Settings chip.

**Craft**
- Match the agenda skeleton to real rows.
- Fade loaded content in.
- Add a reason to disabled Delete.
- Unify command-row styling.
- Strengthen the custom blue dark selected row.
- Add an inner focus treatment for the large shortcut tile.

## Satisfaction

I am satisfied with the overall design direction, and it holds up across palettes and modes. I am not satisfied that it is finished. The eight necessary fixes are the remaining blockers, and all are local changes with no structural problem behind them. Nothing observed prevents understanding or using the core workflows, though the 320px sign-in case can hide its follow-up action.

## Coverage and limitations

**Inspected directly**
- **Core matrix:**
  - All 14 contact sheets.
  - All 44 Mint settings images plus enabled Assistant in both modes and widths.
  - Mint setup and assistant, including 320px, in both modes.
  - Mint model options at both widths in both modes.
  - Every other palette's model options at 320px in both modes.
  - Custom theme selection in both modes.
  - Representative narrow setup and assistant captures from each palette, one mode per palette.
- **Workflows:**
  - Sidebars and assistant states.
  - Research.
  - Account dialogs.
  - Memory, search, Organato, sync, update and onboarding settings.
  - New-tab states.
  - Setup stages.
- **Translation:** both sheets, all 28 palette captures, and all before-sharing and error states including 320px.
- **What's New:** all three sheets, tile indexes, and focused captures of results, table, limitations, patch, passkeys, shortcuts, feature and keyboard focus.
- **Efficiency article:** both sheets, all four desktop tiles, the dark capture, and the focused methodology and table captures.
- **Motion:** all twelve sheets, the motion record, and sample raw frames.
- **Native:**
  - All sheets.
  - All 28 windows.
  - All toolbar and sidebar states, the system-mode window, and the plus-button samples.
  - The start window from both packs.
  - The 600ms motion frame from both packs.
  - Six dense strips around selection and close.
- **Diagnostics:** compact matching icons and the delayed navigation capture.

**Limits**
- I could not play the WebM or MP4 recordings. All motion judgment comes from decoded frames, and I infer no smoothness, input latency or frame pacing.
- Other native motion samples were read from sheets only.
- Remaining What's New tiles and narrow efficiency tiles were read from sheets, with raw focused captures for detail.
- I did not open the additional favorites and new-tab-site captures, which were outside the requested list.
- Image blocks from the first part of the review left my context. I carried forward private notes and re-opened the images behind every necessary fix.
- A blank decoded frame in the tooltip recording remains unresolved. It looks like a recording state, but I cannot confirm that, so I did not score it as a flaw.
- The native window bodies were excluded because they are fixture content. MacOS menus, hit testing, restoration, physical auto-hide, and translation native geometry and bridge behaviour remain unverified.
- Fixture screenshots do not establish provider execution.
