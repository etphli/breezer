# Google Chrome design review

## Overall: 7.7 / 10 (provisional)
This is a confident design score for Chrome's settings pages. It's only a provisional score for Chrome as a whole. The evidence is about 80% one settings template, one new-tab state and one low-resolution marketing composite, and nothing here shows the real product in use.

Chrome looks competent, disciplined and readable, but it isn't refined. It favours clarity and scale over polish.

## Evidence
- **Files inspected:** I read `manifest.json`, all 24 screenshots and `chrome.webp`, including enlarged crops of the toolbar and assistant.
- **Effective coverage:**
  - **Settings:** 11 pages, each with a real light and dark version. No light/dark pair is byte-identical.
  - **New tab:** only one image. `light-newtab.png` and `dark-newtab.png` have the same SHA-1, and both are a dark grey `#3C3C3C` page. Light new tab is not covered.
- **Native interface:** the manifest says the tab strip and toolbar were excluded, so the screenshots contain no live native interface.
- **Likely capture artifacts (not scored as design faults):**
  - The focus ring on the search field appears on every settings page. It looks like autofocus, so it may be normal behaviour, but it is stronger than focus on a page load needs to be.
  - The toggles look caught mid-animation in several captures, such as "Copied to clipboard" (light Accessibility), "Show downloads" (dark Downloads), and those in System and Performance.
  - The "browser is managed" line is odd for a disposable profile, and may come from the setup.
  - The new tab has no native frame and only a basic state: no theme, a sparse shortcut set and no logged-in content.

## Scores

| Category | Score | Basis |
|---|---|---|
| Hierarchy | 7.0 | Page structure is clear, but headings are weak |
| Typography | 7.5 | Clean and very legible, with a narrow scale |
| Alignment | 7.5 | Strong main axes, with small 4–9px drifts |
| Spacing | 7.5 | Row heights are consistent; spacing inside cards is less so |
| Rhythm/density | 7.5 | Calm and scannable, but sparse pages feel empty |
| Consistency | 8.0 | One template holds across pages and both schemes |
| Craft/polish | 7.0 | Solid, but with visible small flaws |
| Color | 7.5 | Restrained light scheme; dark active state is too loud |
| Contrast | 8.0 | Text is strong; off-state and card edges are faint |
| Navigation | 8.0 | Clear and scannable, though the list is long and uneven |
| Controls/settings | 8.0 | Familiar and clearly differentiated |
| New tab | 7.0 | Partial: focused and clear, but only one basic dark state |
| Assistant | 7.0 | Low confidence: marketing composite only |
| Top tabs/toolbar | 7.5 | Low confidence: Windows marketing composite only |
| Responsive layout | **Unverified** | Only 1200×900 was captured, plus an unmeasurable composite |
| Motion | **Unverified** | Still images only; mid-transition toggles show that transitions exist, not their quality |

## Measured contrast
These are sampled from pixels, so they're approximate because of anti-aliasing:
- **Text:** body and secondary text are about 8.4–9.4:1, which is strong.
- **Active nav:** light is about 4.7:1, which passes for normal text but is the weakest text pairing in the set. Dark is about 7.6:1.
- **Nav icons:** about 6:1.
- **Dark card against page background:** only about 1.12:1 (`#292A2D` on `#202124`).
- **Off toggle fill:** about 1.3:1 in light and 1.5:1 in dark. A darker outline and thumb do most of the work there.

## Strengths
- **A strict template:** the sidebar, centred column, card width and row pattern barely change between pages. Moving between them takes no relearning.
- **Disciplined typography:** a single sans family at small sizes reads cleanly, and two-line title and description rows scan very well.
- **Honest controls:** toggles, dropdowns, radios, outlined buttons, chevrons and external-link icons are distinct and sit on a consistent right edge. You can usually predict what a row does before clicking.
- **Matched dark mode:** the layout holds exactly, and text stays highly legible.
- **A focused new tab:** the logo, search field and shortcuts form one obvious centred group with one clear job.
- **A calm assistant concept:** the composite shows a clear greeting, suggestion chips, a visible "Sharing" context chip and a compact input. Showing what's being shared is good trust design.
- **Compact browser controls:** the composite shows the active tab merging into the toolbar, a clear tint separating tab strip from toolbar, and tidy icon groups.

## Weaknesses
- **Weak page headings:** "Appearance" or "On startup" is barely larger than a row label, so the biggest type on the page is the generic "Settings" title. Pages feel unnamed, and a heading sometimes just repeats the row below it ("Search engine", "Default browser", "On-device AI").
- **Heavy light-mode cards:** the white card on a white page depends on a fairly strong shadow. It reads as dated Material design compared with a quieter tonal surface, especially when several stack up in Performance.
- **Loud dark active state:** the saturated `#8AB4F8` pill is the brightest and largest shape on the page. It overpowers the content, whereas the light pill is a soft `#E8F0FE` tint, so the two schemes have different emphasis.
- **Faint dark cards:** with no shadow and only about 1.12:1 separation, cards rely on a subtle tone step.
- **Small inconsistencies:**
  - The "Your Chrome" row uses a small solid arrow, while the rows below use chevrons.
  - "Open your computer's proxy settings" sits above the row's centre, out of line with its icon.
  - Text offsets vary between about 389, 393 and 397px.
  - The search field (about 328–1026px) doesn't match the card edges (about 337–1017px).
  - In Appearance, one divider under "Show home button" looks heavier than the others.
  - "Side panel position" is a label with no control, and its child row is indented.
- **Uneven card structure:** Performance rows have no dividers, while Appearance and Accessibility do. Unlabelled feedback icons also float beside the Performance section headings.
- **Empty short pages:** Default browser and On startup have a single small card in a large blank area. This is honest, but the template doesn't adapt to low-content pages.
- **Plain new tab:** the flat grey page has a pure white search field that is very bright against it. It's clear and has little character, and the bottom half is empty.
- **Busy marketing composite:** even in Google's own image, Ask Gemini, the window controls and many toolbar icons compete. The assistant's gradient is also a different visual language from the plain settings cards.

## What the evidence can and can't support
**Broad design judgment:** the settings system is well supported, with high confidence, and that drives the score for hierarchy, typography, consistency, colour and controls. The new tab is only partly supported.

**Not available:**
- Live macOS tab strip and toolbar, including native window feel, vibrancy and traffic-light integration
- Hover, focus, pressed and drag states, plus tab overflow and tab groups
- Menus, dialogs, omnibox dropdown, side panel behaviour, downloads bubble and profile picker
- Resizing, narrow-width behaviour and motion
- Light new tab, themes and populated shortcuts
- Live assistant behaviour, including answers, streaming, errors and long content
- Chrome's many other internal pages
- Real accessibility use, including keyboard paths and screen readers

Because the assistant and toolbar scores rest on a composite that may be staged, they should count for little, and a live macOS capture could move them either way. I scored from this evidence alone, with no target score in mind, and I didn't look at any Breezer material.

I made no file or PR changes. I used a temporary folder outside the repo for pixel checks and deleted it afterwards.
