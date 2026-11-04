# UI polish evidence

The screenshot set renders Breezer's shipped workspace, settings, new-tab and
assistant documents in Google Chrome using deterministic extension API fixtures.
It exercises the real HTML, CSS and JavaScript. The pages contain sample browsing
and school data. This does not verify native browser window geometry or a newly
compiled Breezer application. The installed app and personal profile are unchanged.

## Reproduce

Install the pinned test dependencies with `npm ci --prefix tests/ai`, then run:

```sh
node script/ui_polish_evidence.mjs capture /tmp/breezer-ui/after
node script/ui_polish_evidence.mjs compare docs/evidence/ui-polish/before /tmp/breezer-ui/after /tmp/breezer-ui/comparisons
node script/ui_polish_evidence.mjs png /tmp/breezer-ui/comparisons
node tests/ai/ui-polish-matrix.mjs /tmp/breezer-ui/matrix
node tests/ai/ui-polish-motion.mjs /tmp/breezer-ui/motion
node tests/ai/ui-polish-chrome.mjs /tmp/breezer-ui/chrome
```

On macOS, the walkthroughs use `/Applications/Google Chrome.app` by default.
Set `BREEZER_TEST_BROWSER` to use another Chromium executable. Capture the
original checkout before editing to generate a new baseline. The checked-in
`before` images are from commit `0d9e9d47`.

The comparisons retain the original screenshots and draw numbered arrows over
the after image. The text below each pair identifies what changed.

## Browser references

The first council round includes official vendor UI images for visual comparison:

- [Safari profiles](https://www.apple.com/v/safari/u/images/overview/customization_profiles__cjv86k82hvo2_large_2x.png), from [Apple's Safari page](https://www.apple.com/safari/).
- [Chrome with Gemini](https://www.google.com/chrome/static/images/gen-ai/ai-innovation/glitter/gemini-in-chrome_desktop.webp), from [Google's Chrome page](https://www.google.com/chrome/). This is a Windows desktop and mobile marketing composite, not a macOS capture.

These are vendor references, not locally captured app screenshots or an equal-task
usability benchmark. Computer Use reported that permissions were not granted, so
native Safari and Chrome window capture was unavailable. Vendor images remain
the property of their respective owners.

## Review method

Formal council rounds use two independent GPT-6.1 Sol reviewers at high reasoning
and one Claude Opus 5.5 reviewer at medium reasoning, launched concurrently with
identical frozen evidence. Only the primary agent implements review feedback.
An earlier three-Sol pass is retained as preliminary feedback, with scores
7.8, 8.0 and 7.8. It is not relabeled as the requested council lineup.
Reviewers receive the actual
screenshots, evidence scope and a request for a candid design score out of ten.
Their briefs omit any desired score or stopping criterion. Each round records
all three scores and specific findings, including disagreements.

The expanded matrix contains 378 raw captures: all eleven custom Settings
categories at desktop and narrow widths in seven palettes and light/dark modes,
plus three sidebar modes, new tab and assistant in every palette and mode.
Checked-in contact sheets index every combination; rerun the command for the raw
full-size set. Selected workflow screenshots and annotated comparisons are also
checked in. Desktop matrix captures use tall viewports to expose every setting.

`chrome/` contains selected real Chrome 156 WebUI captures at 1200 by 900, with
light and dark schemes and a disposable profile. Native tabs and toolbar are
outside these captures. Machine policy adds an organization-managed notice.
The source hashes record the extension files used for the captured design.

Custom UI motion was recorded for space switching, the import card and the new-tab
agenda. `motion.json` records observed animation timings. The runner also checks
that Reduce motion disables those animations. Native macOS motion, top tabs,
toolbar geometry and menus remain explicitly unverified, as requested.

The rubric covers hierarchy, typography, alignment, spacing, rhythm, consistency,
craft, color, contrast, navigation, sidebar, settings and controls, assistant,
new tab, responsive layout and custom UI motion. Reviewers compare Chrome where
the captures support it and mark other comparisons unavailable.
