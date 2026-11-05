# UI polish evidence

The screenshot set renders Breezer's shipped workspace, settings, new-tab and
assistant documents in Google Chrome using deterministic extension API fixtures.
It exercises the real HTML, CSS and JavaScript. The pages contain sample browsing
and school data. This does not verify native browser window geometry or a newly
compiled Breezer application. A separate native capture pass records a private current-UI verification build
using a retained Chromium core and a disposable profile. The installed app and
personal profile are unchanged.

## Reproduce

Install the pinned test dependencies with `npm ci --prefix tests/ai`, then run:

```sh
node script/ui_polish_evidence.mjs capture /tmp/breezer-ui/after
node script/ui_polish_evidence.mjs compare docs/evidence/ui-polish/before /tmp/breezer-ui/after /tmp/breezer-ui/comparisons
node script/ui_polish_evidence.mjs png /tmp/breezer-ui/comparisons
node tests/ai/ui-polish-matrix.mjs /tmp/breezer-ui/matrix
node tests/ai/ui-polish-motion.mjs /tmp/breezer-ui/motion
node script/ui_polish_evidence.mjs sheets /tmp/breezer-ui/after
node tests/ai/ui-polish-chrome.mjs /tmp/breezer-ui/chrome
```

On macOS, the walkthroughs use `/Applications/Google Chrome.app` by default.
Set `BREEZER_TEST_BROWSER` to use another Chromium executable. Capture the
original checkout before editing to generate a new baseline. The checked-in
`before` images are from commit `0d9e9d47`.

The capture command runs the complete Node suite and writes the workflow screenshots in the same pass, followed by the assistant and research walkthroughs.

The comparisons retain the original screenshots and draw numbered arrows over
the after image. The text below each pair identifies what changed.

## Browser references

The initial reviews included official vendor UI references:

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

The expanded matrix contains 490 raw captures: all eleven custom Settings
categories at desktop and narrow widths in seven palettes and light/dark modes,
plus Assistant activity memory enabled, three sidebar modes, desktop/narrow new tabs, assistant panels, expanded model options and setup screens in every palette and mode.
Checked-in contact sheets index every combination; rerun the command for the raw
full-size set. Selected workflow screenshots and annotated comparisons are also
checked in. Desktop matrix captures use tall viewports to expose every setting.

`chrome/` contains selected real Chrome 156 WebUI captures at 1200 by 900, with
light and dark schemes and a disposable profile. Native tabs and toolbar are
outside these captures. Machine policy adds an organization-managed notice.
The source hashes record the extension files used for the captured design.

Custom UI motion was recorded for space switching, the import card and the new-tab
agenda, setup illustration, assistant source picker and browser-control tooltip. `motion.json` records observed animation timings. The runner also checks
that Reduce motion disables those animations. It decodes each recording in Chrome
and exports twelve frames from the first second of visible UI, with a contact sheet for each
of twelve normal/reduced-motion sequences. The detector requires visible edges across columns to exclude blank white/gray recording lead-ins. Each sequence records its video offset and detection thresholds; original videos retain their lead-ins. These samples include transitions rather than
only screenshots taken after a locator settles. They establish neither input latency nor native
frame pacing. Use `node tests/ai/ui-polish-motion.mjs DIRECTORY --decode-only` to regenerate sheets from the same recordings. The release page uses overlapping viewport tiles and a scroll-position index instead of a very tall HiDPI full-page image. The capture asserts a single masthead and includes both default and expanded technical disclosures.

Earlier rounds had no native window evidence. Candidate 12 adds native top-tab,
toolbar and continuous motion captures through the current-process
ScreenCaptureKit API. Menus, physical auto-hide and broader macOS integration
remain outside that evidence. See [the native capture scope](candidate/native/README.md).

Chrome and Safari each received a separate overall review by all three council
members. Chrome's review included real WebUI captures; Safari's used six official
vendor UI references. Neither establishes native runtime or animation quality.
Subsequent rounds review Breezer alone. The full reviews and their evidence limits
are retained in the adjacent Markdown files.

| Review | Sol 1, high | Sol 2, high | Opus 5.5, medium |
| --- | ---: | ---: | ---: |
| Breezer, formal round 1 | 7.6 | 7.7 | 7.5 |
| Breezer, formal round 2 | 8.3 | 8.1 | 8.0 |
| Breezer, round 3 attempt | 8.7 | 8.4 | No score: API rate limit |
| Breezer, round 4 attempt | 8.2 | 8.1 | No score: API rate limit |
| Breezer, round 5 attempt | 8.4 | 8.3 | No score: API rate limit |
| Breezer, round 6 attempt | 8.5 | 8.3 | No score: API rate limit |
| Breezer, round 7 attempt | 8.5 | 8.3 | No score: API rate limit |
| Breezer, round 8 attempt | 8.4 | 8.5 | No score: account limit |
| Breezer, candidate 9 complete council | 8.6 | 8.7 | 8.8 |
| Breezer, candidate 10 interrupted cohort | 8.5 | 8.5 | 8.7, later resume |
| Breezer, candidate 11 complete council | 8.5 | 8.4 | 8.8 |
| Breezer, candidate 12 interrupted cohort | 8.5 | 8.5 | No score: five-hour quota |
| Breezer, candidate 13, two Sol Fast by request | 8.5 | 8.5 | Excluded by user |
| Breezer, candidate 14 complete council | 8.8 | 8.9 | 8.5 |
| Chrome, standalone baseline | 8.0 | 8.0 | 7.7 |
| Safari, standalone baseline | 8.6 | 8.6 | 8.4 |

Baseline scores use the evidence scope described above. They are independent
overall design judgments, not direct browser comparisons or usability benchmarks.

The 22-category web-UI rubric covers hierarchy, typography, alignment, spacing, rhythm/density, consistency,
craft/polish, color across modes, contrast, navigation, sidebar, settings/controls, assistant,
new tab, responsive layouts, custom UI motion, empty/error states, keyboard/focus appearance, onboarding, What's New, the linked efficiency article and the translation window. Native top tabs and toolbar were unverified in rounds 1–11. From round 12, three additional scored categories cover native top tabs, toolbar/window controls and observed native motion, with the compiled-runtime provenance stated.

Historical release-page captures can be reproduced without changing the worktree:

```sh
BREEZER_UI_BASELINE=a063a3c0 BREEZER_AI_EVIDENCE=/tmp/breezer-ui/baseline node --test tests/ai/whats-new-browser.test.mjs
```

The fixture reads that commit’s resources directly from Git. The linked efficiency article is captured at desktop and narrow widths, and in dark system appearance. Its editorial page intentionally remains light.

The translation window has 28 additional appearance captures (seven palettes, light/dark, desktop/narrow), plus eight before-sharing and error states. These use a real disposable MV3 translation session with a fixture appearance bridge. The enabled primary action is measured at at least 5.21:1 text contrast across the matrix; native window geometry and bridge execution remain unverified.

Translation captures also assert one DOM page heading, require two identical consecutive viewport PNGs, and check the empty area below the content for stray painted text. From candidate 13, `translation-capture-geometry.json` records those checks and selected-label text width for all 38 images, including both 320px modes. An earlier frozen capture had a duplicate painted heading without a duplicate DOM heading; its renderer/compositor cause remains unestablished. The current capture guard rejects that artifact.

Static assistant and research captures disable animation during capture, so they show settled text and controls. The separate recordings preserve normal and reduced-motion behavior.

Attempt 8 did not achieve concurrent execution: wait-mode delegation calls were serialized despite parallel invocation. Sol 2 started at 18:22 UTC, Sol 1 at 18:31 UTC and Opus at 18:38 UTC on 4 November 2026. It is incomplete and does not count as a full council round. Future cohorts use asynchronous starts, then collect completion notifications.

Candidate 9 completed the requested concurrent method. Its three runs started at 23:33:00.990, 23:33:01.281 and 23:33:01.348 UTC on 4 November 2026, a spread of 358ms, and all three overlapped for more than eight minutes. All reviewers were satisfied with the observed UI, with scores of 8.6, 8.7 and 8.8. These remain below the user's requested 9.5 threshold. There have been three complete council passes; the candidate numbers retain the intervening incomplete attempts.

Candidate 10 refines translation consent and recovery, selected custom colors, assistant focus and startup state, setup action hierarchy and motion, and editorial reading rhythm. Sixteen annotated before/after pairs are retained in `candidate/comparisons/candidate-10-*.png`. The fresh complete run passed 544 checks with zero failures and two explicit skips, followed by the assistant and research walkthroughs. All 490 matrix captures match the current 50-file UI source fingerprint. All 36 translation captures passed stable-image and geometry guards, and all six reduced-motion assertions passed. The two Sol reviews returned 8.5 each; Opus reached its five-hour account limit and returned no score. This candidate is an incomplete council attempt and remains below the requested threshold. Both Sol reviewers found the narrow research-picker image corrupted; it cannot establish that state’s usability.

Candidate 10 starts were 421ms apart, with all three overlapping for 430.7 seconds before the Opus limit. There are still three complete council passes. The next candidate must resolve the narrow picker evidence before review.

Candidate 11 adds a picker capture guard that rejects the recorded corrupt image, places the control tooltip above the composer, clarifies optional Organato and tour actions, tightens narrow layouts and reduces illustration weight. Ten annotated before/after pairs are in `candidate/comparisons/candidate-11-*.png`. The full suite again passed 544 checks with zero failures and two skips, followed by both UI walkthroughs. All 490 matrix captures match the current source. Four fresh offline native-source checks passed, alongside twelve motion sequences and all six reduced-motion assertions. Native runtime remains unverified. The next requested three-model cohort is deferred until the reported Opus reset; no score or completion is claimed.

The automatic Opus continuation completed candidate 10 at 04:32 UTC on 5 November with a score of 8.7. This is a late completed assessment of the unchanged candidate-10 evidence, not a score for candidate 11. Its initial rate-limit failure and resumed review are retained in `formal-round-10-3.md`. The cohort remains marked interrupted. Its newly confirmed findings were resolved before candidate 11’s first simultaneous review.

Before its first council, candidate 11 was revised using that late feedback. Settings headers now follow the content grid at intermediate widths; narrow fields and toggles share their row insets. Error alerts span the available column, and update failures preserve the controls’ description. The passkey illustration matches the availability action. New-tab errors use recovery wording, an aligned empty shortcut and a nearby hint; feedback follows the content edge. The efficiency article uses the same Previous Breezer label as the release page. The resting shortcut image now excludes the test’s deliberate focus; a separate keyboard-focus image retains that evidence. Nine additional annotated comparisons are in `candidate/comparisons/candidate-11-revised-*.png`.

The revised candidate again passed 544 Node checks, with zero failures and two explicit skips, both browser walkthroughs, all 490 source-matching matrix captures, all 36 guarded translation captures, twelve motion sequences and all six reduced-motion assertions. Four fresh offline native-source integration checks passed. These source checks do not verify native appearance or runtime. GPT-6.1 Sol wrote this revision; the council supplied read-only design feedback. All work remains local; no PR update or installation has been performed.

Candidate 11’s three reviews completed at 8.5, 8.4 and 8.8. Starts were 729ms apart, overlapping for 522.675 seconds. All were satisfied with the observed design, with two narrow capture gaps preventing full evidence sign-off. These scores remain below 9.5. There are now four complete simultaneous council passes. Main-agent refinement continues locally; no further council is commissioned.

Candidate 12 groups translation languages and consent into one form, puts model
choices before advanced options, quiets the assistant activity line and anchors
the browser-control tooltip. Source choices become visibly disabled at the
six-tab limit. Update availability leads its action, saved-key removal is an
explicit destructive action, and Organato failures stay beside the action that
failed. Narrow setup navigation fits at 320px and uses “Connect later”. The
Organato illustration is retained. Twelve annotated comparisons are in
`candidate/comparisons/candidate-12-*.png`.

The complete test-file coverage passed across resumed batches: 337 successful
checks before a parent-turn interruption, 134 passing and two skipped in the
remaining batch, and 73 root checks. A subsequently reproduced update-timeout
recovery defect was fixed and all 19 updater/lifetime checks passed, including
one new regression. This is 545 distinct passing checks, zero unresolved failures
and two explicit skips. The affected settings browser walkthrough also passed.
The saved-key walkthrough also reproduced and corrected unintended removal when
clicking its row heading; removal now requires the explicitly named button.
The interrupted output and exact resume boundary are retained in the verification
record, rather than represented as a single uninterrupted run.

The final 490 captures match all 50 current UI source hashes. All 36 translation
captures passed their geometry and paint guards. The two faulty narrow assistant
captures now require stable consecutive CSS-pixel images and matching surface
paint; the recorded corrupt profile image is a negative control. Twelve fresh
custom-UI motion sequences passed all six reduced-motion assertions. Four offline
native-source checks also passed.

Native capture works without Computer Use or a screen-recording grant. A
capture-only library runs inside an isolated Breezer process and uses
ScreenCaptureKit’s current-process window API. The pack contains 38 normal native
window captures, one reduced-motion start capture and two continuous MP4s,
including all seven palettes in light/dark at 1100px and 540px native widths.
The runtime is the installed 1.2.0 app, with matching unchanged native workspace
inputs and upstream source tree. Its older packaged web UI is excluded from the
candidate web-UI assessment. Installed binary/framework hashes match before and
after; owned processes exited and temporary profiles were removed.

GPT-6.1 Sol wrote candidate 12 and its capture tools. No new council has reviewed
it, and no 9.5 score or completion is claimed. All changes remain local. PR #17
has not been pushed or updated.

Candidate 12 returned 8.5 from both Sol reviewers. Both were satisfied overall,
with one necessary fit correction: the narrow From selector clipped the end of
“Detect language”. Native top tabs, toolbar/window controls and sampled native
motion were scored directly with the compiled-runtime provenance stated. Opus
exhausted its five-hour quota before completing the review and returned no score.
The three calls were issued together; actual provider starts were 11.234 seconds
apart and all three overlapped for 466.195 seconds. This remains an incomplete
council attempt, so there are still four complete simultaneous passes.

Candidate 13 fixes the clipped translation label and stacks language controls at
320px. Settings search names the setting and current choice. Activity memory has
shorter copy and aligned summary rows while retaining explicit provider consent.
Signed-out setup discloses technical instructions behind a clear first action.
Update status spacing, Organato error grouping and methodology reading measure
are refined. Secondary release diagrams open with their technical disclosures;
the default narrow release page is 785px shorter. Chrome's chart key is consistent
across comparisons, without changing any measurements. Thirteen annotated pairs
are retained in `candidate/comparisons/candidate-13-*.png`.

One uninterrupted suite passed 545 checks with zero failures and two explicit
skips, followed by both browser walkthroughs. All 490 matrix captures match the
50 current UI source hashes. All 38 translation captures pass stable-frame,
heading, paint and selected-label fit guards. Twelve fresh motion sequences pass
all six reduced-motion assertions. The 39 native window captures and two native
recordings are reused after verifying every file hash and unchanged native
inputs. GPT-6.1 Sol wrote this refinement. It has no council score yet; the 9.5
threshold remains unmet. All work remains local and PR #17 remains unpushed.

Candidate 13 completed the user-requested two-Sol Fast exception at 8.5 each.
Both used high reasoning and priority service, received identical neutral briefs
and were satisfied overall. Actual starts were 2.395 seconds apart and overlapped
for 909.146 seconds. They inspected 352 and 351 images. One identified low-contrast
Mint/Pollen light profile icons; the other identified clipped sidebar controls at
the resting native auto-hide edge. These findings concern the compiled 1.2.0
native evidence. The normal two-Sol/one-Opus lineup resumes after this exception.
No score meets the 9.5 threshold, and PR #17 remains unpushed.

Candidate 14 moves browser control beside its page source, anchors the tooltip,
simplifies the composer, and keeps import actions visible with detailed guidance
in a disclosure. Layout helpers are shorter and expanded release summaries retain
their text measure. The native placeholder profile uses the toolbar foreground;
the resting auto-hide edge no longer exposes sliced sidebar controls. Eleven
annotated before/after pairs were shown before commissioning the next council.

The complete suite passed 545 checks with zero failures and two skips, plus both
UI walkthroughs. All 490 matrix captures match the fifty current UI sources;
all 38 translation captures and six reduced-motion assertions pass. Fresh native
evidence has 39 windows and two continuous recordings from a private verification
build using retained Chromium 156 core inputs, nine newly compiled UI/resource
units and the current fifty-file UI payload. All loaded resources were hashed
through the running extension. This is not a full product/release rebuild.
Native stroke/background samples exceed 8.8:1 across all fourteen modes/palettes.
Installed app pins remain unchanged and every owned capture process exited.

Candidate 14 used the restored two-Sol/one-Opus simultaneous council.
The neutral brief asks for a short concrete reason beside every category below
10, with plain descriptions rather than filenames in the returned report.
Exact references remain in private coverage ledgers. No stopping threshold or
past scores are supplied. The user's 9.5-per-reviewer goal remains unmet.
All work remains local and PR #17 is unpushed.

Candidate 14 completed at 8.8, 8.9 and 8.5. Actual starts were 0.399s apart, with all three overlapping for 668.895s. This is the fifth complete simultaneous three-model council. The two Sol reviewers were satisfied overall; Opus requested alignment and theme refinements before full sign-off. All returned a concrete reason beside each category below 10. These scores remain below the requested threshold. Candidate 15 work is local and PR #17 remains unpushed.

Candidate 15 increases supporting-text readability, separates account connection
from model choices, consolidates working status and repeated reply branding, and
separates memory save/erase actions. Translation recovery honors provider retry
deadlines with a countdown. Narrow related fields align, space actions remain
attached, setup has one tour counter, new-tab loading reserves space, and the
release/reference pages have clearer navigation and reading measures. Compact
icons share an axis and fallback identities use two letters. Graphite native
chrome is grayscale; custom accents retain hue with measured text contrast.

The full suite passes 547 checks, zero failures and two skips, followed by both
walkthroughs. The refreshed 490-state matrix matches all fifty UI files. There
are 38 stable translation captures, twelve motion sequences, and 39 fresh native
windows with two continuous recordings. The private native build reuses eight
unchanged current UI units and freshly compiles the appearance bridge. It is not
a full product/release rebuild. Twenty-two annotated before/after pairs precede
the next review. All work remains local; PR #17 is unpushed and the requested
9.5 score from each reviewer remains unmet.

Round 15 Opus returned 8.7, satisfied with the direction but requesting further
refinement. Its report covers 25 categories and explains each shortfall. Its
actual run lasted from 13:16:14.373Z to 13:27:26.162Z on 5 November 2026. The two
Sol results remain pending; there is no complete round-15 result or inferred
score. No new review has been launched.

Candidate 16 restores dark select arrows, clears masthead focus and shadow,
separates footer actions, corrects import guidance and aligns its padding. Memory
Save belongs to its fields and is enabled only for pending changes. Translation
prioritizes Stop while running. New-tab loading now declares its state, so its
reserved space applies; the date keeps one anchor when Organato is toggled. Pin
and New space icons are distinct, favorite identities use one frame, and inactive
titles use the space of hidden close controls. Browser tools has a distinct label.

The complete suite passed 547 checks, zero failures and two skips, plus both
walkthroughs. The 490 captures match all fifty UI files; 56 select-arrow checks,
72 compact layout combinations and all six reduced-motion assertions pass.
Fresh native evidence includes 41 windows and two recordings, with all 78 encoded
header frames decoded separately. Nine unchanged native units were reused with
the current fifty-file UI payload. Physical-input and temporal limits remain
explicit. Fourteen annotated before/after pairs are prepared before the next
review. The installed app and profile are unchanged; PR #17 remains unpushed.

Round 15 is complete at 8.8, 8.8 and 8.7. Actual starts were 0.721 seconds
apart and all three overlapped for 671.068 seconds. Both Sol reports confirm
focus clearance and footer spacing as concrete finishing issues; those were
already corrected in candidate 16. Their remaining accepted feedback adds
command copying, stronger dark consent boundaries, direct sync recovery, plain
provider-failure summaries with exact details disclosed, and secondary setup
import emphasis. The final candidate 16 pack refreshes every source-matching
state. Nineteen annotated comparisons were shown before the next council.
The threshold remains unmet; all work stays local and PR #17 is unpushed.
