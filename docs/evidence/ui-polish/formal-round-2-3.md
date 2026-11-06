# Breezer design review: round 2 frozen evidence

**Overall: 8.0/10.** I'm not satisfied yet. The design system is strong, but four visible defects in common or critical states should block sign-off. All findings come from Chrome fixture renders.

## Scores

| Category | Score | Basis |
|---|---|---|
| Hierarchy | 7.9 | Primary actions are clear. Settings section titles sit too close to row titles, and some pages repeat the same name, such as Sync three times. |
| Typography | 8.4 | Good type quality, especially What's New and the new tab. The product uses three type voices, which is defensible. |
| Alignment | 7.9 | The main columns are disciplined, with small 2–6px drifts listed below. |
| Spacing | 8.3 | Consistent rows and cards. The research picker is the outlier. |
| Rhythm/density | 8.0 | Settings feels calm. The assistant's bottom controls get heavy while it is working. |
| Consistency | 7.7 | Mostly one system, but states and small components vary. |
| Craft/polish | 7.7 | High baseline, reduced by overlaps, clipping and default browser controls. |
| Color across modes | 8.5 | All palettes held up on the sheets, in both modes. |
| Contrast | 7.9 | Body text is good. Dark placeholders and Graphite dark toggles are the weak spots. |
| Navigation | 8.4 | Clear settings navigation and search. The narrow layout uses a native select. |
| Sidebar | 8.5 | Strong hierarchy and states. Compact mode is slightly uneven. |
| Settings/controls | 8.0 | Strong structure, but some controls misstate availability. |
| Assistant | 7.3 | Conversation is good. Signed-out and research states are not. |
| New tab | 8.1 | Strong desktop page, weaker at narrow width. |
| Responsive layouts | 7.4 | Settings adapts well. The new tab, What's New table and signed-out assistant break. |
| Custom UI motion (from frames and timings) | 7.8 | Sampled frames show quick, restrained motion, and reduced-motion runs record no animations. The WebM files were not played. |
| Empty/error states | 7.6 | Often useful, but inconsistent and sometimes wrongly ordered. |
| Keyboard/focus | 8.7 | Visible, on-theme focus rings in every focus capture opened. |
| Native top tabs/toolbar | **Unverified** | No score given. |

## Necessary fixes

### Blockers
1. **`sidebar-signed-out-narrow.png`:** the sign-in card overlaps the second heading line, "Ethan?". The `codex login` and `claude auth login` commands also blend into the prose.
2. **`whats-new-results-narrow.png`:** the results table's value column and header are cut off (`742.1`, `712.8–8`, "Breezer 1 / candi"). No scroll cue is visible, and I could not confirm whether the table scrolls.
3. **`newtab-narrow.png`:** a shortcut tile and its label are sliced at the edge next to Add shortcut, with no sign of scrolling. `newtab-organato-off-narrow.png` hides the overflow more cleanly, but its gaps are uneven.
4. **Research sources:** this flow needs a pass across three states.
   - **`research-picker.png`:** it uses default blue checkboxes in Mint, repeats "Choose up to six tabs", has oversized rows, and shows no selected count while four tabs are checked. Done is also weak as the only commit action.
   - **`research-selected-tabs.png`:** "2 selected tabs · text only · no control" wraps into a narrow three-line right-aligned stack beside empty space.
   - **`research-partial-failure.png`:** source details run together as one paragraph. "Source closed during capture." and "Response stopped." have no warning treatment or recovery action.

### Other necessary fixes
5. **`onboarding-narrow-no-bridge.png`:** the options are dimmed, but the explanation sits below Back, progress and Continue. It should appear before the disabled controls.
6. **`mint-light-settings-newtab.png`, also `settings-organato-dark-custom.png`:** Disconnect looks enabled while the page says Organato still needs connecting.
7. **`mint-light-settings-passwords.png`:** Manage local passkeys looks enabled beside "not available in this build". Sync's unavailable button is correctly disabled.
8. **`custom-dark-settings-appearance.png`, `custom-light-settings-appearance.png`:** the only sign that a custom theme is active is a ring on Apply color. It reads like focus, and no theme tile is selected.
9. **`graphite-dark-settings-layout.png`:** the off toggle's white knob is brighter than the on toggles' muted gray tracks, which makes the state harder to read. Mint dark uses the same knob pattern, but the color separates the states better.
10. **`onboarding-8-done-organato-off.png`:** the preview says "What are we working on, there?" in accent color. It's awkward, and it doesn't match the real no-name heading in `sidebar-model-menu.png`.
11. **`onboarding-6-organato.png`:** after connecting, success is plain text, and Connect stays as a filled button competing with Continue.
12. **`onboarding-6-organato-optout-failed-narrow.png`:** the illustration clips a second chip at the bottom and reduces favorites to faint dots. The error box also turns muddy gray-green.
13. **`whats-new-narrow.png`:** "Read about the efficiency work in 1.2" wraps inside its pill with cramped, left-aligned text.
14. **`newtab-loading.png`:** the Organato card starts about 18px higher than `newtab-connected-light.png`, so it will shift when data arrives. Refresh also looks active while loading and in `newtab-setup.png`, where there is no key yet.
15. **`mint-dark-settings-assistant.png`, `mint-dark-settings-languages.png`:** placeholders look low contrast, based on a visual estimate rather than a measurement.
16. **`mint-light-settings-passwords.png`, and the other "What…" or "About…" disclosures:** default black triangles clash with the line icons. Passwords also adds divider lines that other pages don't use.
17. **Small alignment drifts:**
    - **`custom-light-settings-appearance.png`:** theme tiles sit 4px inside the cards below.
    - **`mint-light-settings-assistant-narrow.png`:** "Sites" sits 2px off the row above.
    - **`settings-redesign-search-light.png`:** section labels sit about 5px off the result cards.
    - **`sidebar-error-narrow.png`:** Edit and resend doesn't align with the error box.
18. **`settings-redesign-search-light.png`, `mint-light-settings-browser.png`:** "Chromium settings", "chrome://settings" and "Browser settings" name the same thing differently.

## Optional taste
- **`mint-light-settings-assistant-enabled.png`:** add dividers to Activity summary to match other cards.
- **`sidebar-working.png`:** remove the duplicate stop control and reduce the repeated source labels.
- **`newtab-organato-off-light.png`:** the layout feels left-heavy when alone on the page.
- **`rose-light-settings-assistant-enabled.png`:** the primary rose sits close to destructive red.
- **`newtab-error.png`, `newtab-custom-shortcuts.png`:** the empty-shortcuts hint and centered status text feel detached from the left-aligned content.
- **`newtab-connected-light.png`:** the to-do list mixes date markers with a circle.
- **`mint-light-sidebar-compact.png`:** the chevron and folder pair sits off the shared icon axis.

## Coverage and limitations

**Opened:**
- All 14 contact sheets.
- All 48 Mint settings images, including enabled Assistant at both widths and modes.
- All requested workflow images, except that the What's New narrow results were viewed only as a table crop.
- Raw palette details:
  - Custom: Appearance light and dark, Spaces dark.
  - Rose: Appearance dark, Assistant enabled light.
  - Pollen: Layout dark, new tab dark.
  - Graphite: Layout dark.

**Correction:** my first pass returned no image data, so early progress notes that called evidence "read" were wrong. Those two issue mentions had no basis at the time. The findings above come only from images that later rendered.

**Not fully inspected:**
- `whats-new-close-refused.png`: my crop showed only the hero, so the refusal state is unverified.
- The full-length What's New captures were not reviewed end to end.
- Tide and Dusk raw settings were reviewed through sheets, plus `newtab-connected-dark-tide.png` and Dusk onboarding.
- Non-Mint narrow settings were reviewed on sheets only.
- `ffmpeg` is unavailable, so I did not play the WebM files. I used `motion.json` and sampled frames from all three flows, but not every frame:
  - Settings import shows no visible expansion in the frames I opened, so that transition stays unverified.
  - Space switching was judged mainly from its normal-motion frames.

**Possible capture artifacts, not counted as defects:**
- `sidebar-welcome.png`, `settings-onboarding-dark-custom.png` and `workspace-sidebar-personal.png` look caught mid-animation.
- Matrix new tabs show identical blue icons, which appears to be fixture data.

**Unverified and outside the score:**
- Native top tabs and toolbar.
- macOS window and menu integration.
- Physical auto-hide and native animation.
- Runtime appearance of native layout settings.
- Real inference or provider behavior.

I edited no source, evidence or PRs and delegated nothing. I wrote three temporary crops to `/tmp/breezer-review-scratch-opus/`.
