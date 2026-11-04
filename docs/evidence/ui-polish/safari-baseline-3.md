# Safari visual design review

## Overall score: 8.4/10

This score covers the visible design in Apple's curated marketing images. On that evidence, Safari is a highly refined, calm and professional interface with strong component craft. Its main weaknesses are translucency that makes legibility depend on the background, too many small variations between components, and some weak secondary contrast.

I inspected all six images and the manifest. Website content, photography, wallpapers and device hardware are excluded. Contrast judgments are by eye, not measured.

## Category scores

| Category | Score | Basis |
|---|---:|---|
| Hierarchy | 8.5 | Browser controls stay quiet and content leads, but the Privacy Report sheet is underpowered. |
| Typography | 8.5 | System type is disciplined and clear, though small secondary text gets faint. |
| Alignment | 8.5 | Toolbar, sidebar and list edges are precise, with a few weak spots. |
| Spacing | 8.5 | Toolbar and sidebar spacing is generous, but some panels leave awkward voids. |
| Rhythm/density | 8.0 | The tab-group sidebar is excellent, but Reading List rows are uneven. |
| Consistency | 7.5 | The family resemblance is strong, but details drift between surfaces. |
| Craft/polish | 9.0 | Corners, icons, shadows and capsule grouping are the set's biggest strength. |
| Color | 8.5 | Restrained neutrals and sparing blue work well. Group color is useful but can be too loud. |
| Contrast | 7.0 | Primary text is fine, but glass, inactive and secondary states weaken it. |
| Navigation | 8.5 | The sidebar structure is clear and organized around tab groups. |
| Tabs/toolbar | 8.5 | The grouping is clean, but the active tab has limited separation. |
| Start page | 8.0 | The modular sections are attractive, but legibility depends on the wallpaper. |
| Profiles/tab groups | 8.5 | Identity and organization are clear, with some contrast and redundancy problems. |
| Reading List | 8.0 | The content is rich and adapts well, but the Mac list is dense and uneven. |

## What works best

- **Controls stay out of the way:** the toolbar clusters sidebar, navigation, address and page actions into calm groups. In `customization.jpg`, the page clearly stays primary.
- **Sidebar structure is the best surface in the set:** in `tab-groups.png`, the row pitch is steady, the section labels are quiet and the indentation is clear. The selected row is immediately obvious.
- **Components feel related:** favorites tiles, cards, popovers and sheets share similar corner softness and restraint.
- **Profile identity is easy to spot:** in `profiles.png`, the colored profile capsule tells you which window context you are in at a glance.
- **Reading List adapts by device:** Mac, iPad and iPhone versions each suit their form while keeping the same thumbnail, title, source and excerpt structure.

## Problems

1. **Glass makes legibility conditional.**
   - The tab-group sidebar picks up blotchy color from the photo behind it, which adds visual noise to an information-heavy surface.
   - Start-page headings and favorite labels depend on the wallpaper. The small labels in `hero.jpg` are especially fragile.
2. **Secondary and inactive states are weak.**
   - The inactive `School` profile capsule nearly dissolves into its gray background.
   - Disabled navigation, Reading List excerpts and metadata are all faint.
   - White text on the orange `Home` capsule also looks low-contrast.
3. **Selection styling is inconsistent.**
   - The tab-group sidebar uses a rounded light fill with blue text.
   - The Mac Reading List uses a heavy, square-edged slate block.
   - The iPad Reading List uses a rounded gray fill.
   - Segmented controls also vary between solid blue and white.
4. **The toolbar can get busy.** Sidebar, profile, navigation, extension and address capsules create a long row of near-equal containers. The colored profile capsule can also outrank the address field.
5. **The active tab is understated.** The white pill on a pale strip works, but only through a subtle tonal step. Truncated titles and dividers add some fine-grain noise.
6. **The Privacy Report varies in quality.**
   - On the start-page card, the left side has a large void and `Show More` sits detached at the bottom.
   - On the iPad sheet, the title is small and the data tiles lack impact. Sentence-case labels sit beside uppercase ones.
   - In the popover, the condensed `12` differs from the surrounding type and the slate treatment looks a little dated. The list dividers don't line up with the full-width header divider.
7. **The Mac Reading List loses rhythm.** Variable title and excerpt lengths produce uneven row heights, while thumbnails, source lines and excerpts compete in a narrow column.
8. **Sidebar labels and icons repeat.** `Start Page` appears at the top level, inside the group and as a tab, while tab-group rows all use the same icon. The labels stay clear, but scanning relies heavily on text.

## Overall judgment and evidence coverage

**The 8.4 is my judgment of the visible design.** It is not a claim about the full shipping app. I held the score below 9 mainly because of contrast dependence and component drift, even though the craft often reaches a 9.

**The evidence is narrower than the full product.** It covers selected views of the toolbar, tabs, start page, profiles, tab groups, Privacy Report and Reading List.

| Area | Status |
|---|---|
| Settings | Unverified |
| Dark mode | Unverified; no complete dark browser UI is shown, and dark glass over a photo doesn't establish it |
| Responsive behavior | Unverified beyond separate Mac, iPad and iPhone layouts |
| Motion | Unverified |
| Hover, focus, pressed and other interaction states | Unverified |
| Native runtime behavior and performance | Unverified |
| Accessibility settings, including reduced transparency and increased contrast | Unverified |
| Live menus, dialogs, overflow and dense real-world tab use | Unverified |

## Confidence and blind spots

- **Visual craft of the shown surfaces: high confidence.** Most of the observations above are directly visible, and the patterns recur across images.
- **Whole-product visual quality: moderate confidence.** Apple chose flattering content, short lists and tidy states. Real sites, long tab lists and poor wallpapers could lower the score, especially for glass legibility.
- **Consistency: moderate confidence.** The images mix platforms, and the Privacy Report popover may be an older asset. The manifest has no capture dates, so some drift could come from the source images rather than one current release.
- **Cropping:** several images are partial views, so I gave limited weight to apparent clipping or empty space near crop edges.
