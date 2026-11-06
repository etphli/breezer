# Breezer design review: current rendered UI

**Overall design quality: 9.2 / 10.** The product is calm, consistent and professional across all seven palettes in both modes. I found four small fixes and no structural problems.

## Scores

| Category | Score | Why it fell short of 10 |
|---|---:|---|
| Hierarchy | 9.3 | Translation's Save stays a filled primary button with nothing to save. New tab settings says "connect Organato" twice. |
| Typography | 9.3 | "read-only" breaks across lines. Setup's tight bold sans headings differ from the serif used on New Tab and What's New. |
| Alignment | 9.0 | Model menu right edges differ by 1–3px. Narrow Save buttons sit about 2px inside their fields. The empty-state Add shortcut tile sits 11px right of the date. |
| Spacing | 9.2 | Short pages such as Sync leave most of the screen empty. Desktop setup content sits high, with a large gap above the footer. |
| Rhythm/density | 9.2 | Density swings from the sparse Sync page to the dense password import guide. The new-tab agenda card moves 30px between error and ready states. |
| Consistency | 8.9 | Save behaves differently in Memory and Translation. Long titles use a fade in top tabs and an ellipsis in the sidebar. The same sign-in command has two layouts. |
| Craft/polish | 9.0 | Two text overflows. The setup illustration's shadow ends in a faint straight edge. |
| Color across modes | 9.3 | The Custom color swatch stays green under other themes. Dark popovers barely separate from the panel behind them. |
| Contrast | 9.2 | The "Retry in 30s" countdown is low contrast but carries meaning. The light-mode page frame hairline is very faint. |
| Navigation | 9.4 | What's New anchors don't show the current section. Sync's only action leads to update settings. |
| Sidebar | 9.2 | The selected space pill looks different between Work and Personal. Compact two-letter codes are abstract. |
| Settings/controls | 9.0 | Translation Save has no unchanged state. Button widths mix on narrow Assistant settings. The stale swatch and the Sync action also count here. |
| Assistant | 9.1 | The Control tooltip points at the wrong row. The Claude command overruns its chip at 320px. Status rows stack above the composer. |
| New tab | 9.4 | Loading skeleton dividers and tile count don't match the loaded page. The error state gives the same instruction twice. |
| Responsive layouts | 9.0 | Two narrow-only overflows. Narrow top tabs show little of each title. |
| Custom UI motion | 9.2 | The new tab skeleton swaps abruptly to content. *Decoded frames only; onset, latency and pacing not established.* |
| Empty/error states | 9.0 | The fallback setup notice spills out of its banner. New Tab's error repeats itself. Sync's unavailable state offers a weak next step. |
| Keyboard/focus appearance | 9.2 | The shortcut focus ring is oversized, and its remove button sits on the ring's corner. *Native focus not evidenced.* |
| Onboarding | 9.1 | Fallback notice overflow and clipped illustration shadow. The Organato step offers three separate exits. |
| What's New | 9.4 | The hero fills the first desktop viewport. There is no active section indicator. Expanded disclosures are uniform grey prose. |
| Efficiency article | 9.3 | The top "Back" pill reads like a primary action. Tables stop short of the full-width section rule. The 320px header rule is segmented. |
| Translation window | 9.4 | Reload languages sits high in the hierarchy. "What is shared" has an extra indent. The countdown is faint. *Native geometry and bridge unverified.* |
| Native top tabs | 9.1 | Tinted separators look uneven around the active tab. Narrow widths truncate titles heavily. *Private UI build: retained Chromium 156 core reporting 0.20.1.1, shell metadata 1.2.0, current web resources repacked; settled captures only.* |
| Native toolbar/window controls | 9.1 | An empty bookmarks row costs a full bar. The centered address's info icon sits far from its text. Dark mode dims the third-party extension icon. *Same private build; physical hit testing unverified.* |
| Observed native UI motion | 9.0 | Close slides but selection cuts instantly. The centered-address change jumps. The closing tab clips its icon. Reduced mode removes the slide. *Same private build; decoded-frame judgment only; frame pacing and physical interaction unverified.* |

## Necessary fixes

1. **Claude sign-in command, 320px assistant.** The text "claude auth login" runs about 4–5px past its grey chip and nearly reaches Copy. Fit the chip to the text, or use the wrapped layout from the account dialog.
2. **Setup notice when browser integration is missing, narrow.** "Defaults are shown." falls below the tinted banner and touches the illustration. The banner must grow with its text. This appears only in builds without that integration.
3. **Browser Control tooltip.** Its arrow lands on the "Included" row, one row above Control, so it appears to describe the wrong item. Anchor it to Control.
4. **Translation settings Save.** It stays filled when nothing has changed, while Memory correctly disables it until an edit. Use one rule for both.

## Optional improvements

**Consistency and clarity**
- Show the applied theme color in the Custom color swatch, or a neutral state.
- Rename Sync's action to something direct, such as "Check for updates".
- Remove one of the two "Connect Organato" messages, and keep "read-only" from breaking.
- On New Tab's error, shorten the message so the button carries the instruction.

**Craft**
- Align the model menu's right edges to a single line.
- Remove the straight edge from the setup illustration's shadow.
- Match the new tab skeleton to the loaded layout, and cross-fade between them.
- Show the current section in What's New.

**Taste**
- Hide the empty bookmarks row.
- Use one truncation style for tab titles.
- Give selected tabs a brief transition to match close.
- Strengthen dark popover edges.
- Make the top "Back" pill quieter in the efficiency article.

## Verdict

**I'm satisfied with the overall design.** The four fixes above are the only remaining blockers, and none requires redesign. I rechecked items 1–4 against raw images, and I also rechecked the optional findings marked from raw images.

## Coverage and limitations

**Reviewed**
- All 14 palette contact sheets.
- All 44 Mint settings images, plus Assistant enabled in both widths and modes.
- Mint setup and assistant, including 320px in both modes.
- Mint model options, and every other palette's narrow model options in both modes.
- Sample narrow setup and assistant images from each other palette.
- Custom theme selection in both modes, and sample images from Pollen dark and Tide light.
- All listed workflow, new tab, onboarding, research, sidebar and detail states, and the compact icon diagnostics.
- All three What's New sheets, both efficiency sheets, and all focused What's New and efficiency captures.
- All 38 translation captures and both translation sheets.
- All 12 motion sheets and `motion.json`.
- All native manifests, frame records, sheets, 28 top-tab windows, toolbar and sidebar frame states, and the new-tab button close-up.

**Sampled only**
- What's New tiles: 2 desktop, 1 narrow and 1 expanded.
- Efficiency tiles: 2 desktop and 1 narrow.
- 4 motion video frames, and none of the settled timed motion images.
- Native motion: both start windows, 2 normal frames and 1 reduced frame.
- 5 raw dense header strips, around selection, close and the address change.

**Limits on the evidence**
- Older image results were trimmed from context, so those findings rest on my private ledger and are less certain unless reopened.
- I did not play the WebM or MP4 recordings. All motion judgments come from decoded frames, and that excludes smoothness, input latency, frame pacing and animation onset.
- Compact sidebar 12px and 20px captures are pixel-identical. Pinned frameless and full address are also identical at rest. I could not tell whether the compact result is intended.
- The dark model menu lacks the allowance line shown in light mode. I did not determine whether that is a state difference.
- macOS menus, physical hit testing, restoration, physical auto-hide, translation window geometry and bridge, and provider execution remain unverified.
