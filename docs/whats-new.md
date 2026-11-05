# Update pages

The bundled update page is `features/ai/extension/whats-new.html`. Its cream design contains the current minor release's features and appended patch notes. Open it in Breezer at:

```text
chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/whats-new.html
```

## Code map

| File under `features/ai/extension/` | Responsibility |
| --- | --- |
| `whats-new.html` | Feature copy, patch sections and local illustrations. |
| `whats-new.css` | Cream palette, layout, artwork, focus, forced colors and reduced motion. |
| `efficiency.html` | Linked measurement article, comparison tables and methodology. Reuses `whats-new.css`. |
| `whats-new.js` | Reads `RELEASE_VERSION`, sets the masthead/title with `textContent`, closes this tab on Continue browsing and handles close refusal. |
| `release-info.js` | Published version and derived minor-page version. For example, `1.1.2` maps to `1.1.0`. |
| `release-notes.js` | Opens the page once per minor release in a regular window, deduplicates existing tabs and records `breezer.releaseNotesSeen`. Private windows are excluded. A brand-new profile gets the setup guide (`workspace.html#/welcome`) instead and skips the current notes; see [workspace.md](workspace.md#first-run-setup). |
| `manifest.json` | Extension version, kept in step with a published release. |

## Template and release workflow

Use [templates/whats-new-release.md](templates/whats-new-release.md) for the authoring template and checklist. The live HTML and CSS are the canonical visual template, so copy their structure rather than maintaining another full stylesheet.

Keep each primary feature's heading and short introduction in `.feature-copy`, beside its illustration. Use a single-column `.feature-secondary` for supporting technical notes; keep their heading, introduction and disclosure stable when expanded. Put optional `.feature-details` directly inside the `.feature` article, after the introduction and illustration. The disclosure spans both columns so expanded explanations have a readable line length without leaving a tall empty illustration column.

For a new `1.x.0` edition, replace the previous edition's feature and patch content with the new release's illustrated feature rows. Keep the shell, version hooks, actions, accessibility and known-limitations section. Historical editions remain in Git tags and published release evidence. The stable URL stays the same; a new edition does not require another browser route.

For `1.x.1`, `1.x.2` and subsequent patches, append an illustrated patch section to the existing edition. Preserve its earlier changes. Updating `RELEASE_VERSION` automatically derives the same `RELEASE_PAGE_VERSION`, so existing readers do not get a new tab. A user who has never seen that minor edition can still see it once.

Only bump published version metadata as part of preparing an actual release. Page-artwork work alone does not rewrite an already published DMG or authorize a local installation. The user currently requires an explicit request before changing their installed app.

## Illustrated patch layout

Each patch has a `.patch-lead` row for its main illustration and related notes, then a `.patch-pair` with two `.patch-group` blocks. Each group has a `.plate.patch-plate` figure, decorative `svg.art`, a heading and a `.notes` list. Both layouts stack at 720px. Artwork colors come from the page palette through the `.art` rules in `whats-new.css`.

A patch may add a second `.patch-pair` and end with a `.patch-limit` block that states what keeps its normal behavior or what the change cannot promise.

The 1.2.0 draft has seven illustrated primary rows and three compact technical notes. Its first six entries cover the setup guide, custom shortcuts, Organato task links, sidebar snapshot ordering, idle helpers and storage cleanup. Additional rows come from accepted merged features:

- PR #7 adds limited native passkey-management guidance and retains the Apple signing limitation. It does not announce Touch ID, Apple Passwords or complete platform enrollment.
- PR #8 adds research across at most six explicitly selected, text-only page sources, separate from browser control. Citation quality depends on the model. Text exclusions are heuristic, not universal secret detection.
- PR #9 adds page translation with a running local LibreTranslate server or the user's own LibreTranslate.com key, with confirmation before sharing text. It does not claim bundled models, AI-account access or general translation quality.
- PR #10 adds the settings category list, search and All settings destination for full browser settings. Translation mounts under Translation, passwords/passkeys stay under Passwords and Sync stays hidden until its module mounts.

The shortcut row also includes merged PR #11: sidebar favorite/pin number slots open only the selected page lazily, reuse it on repeat and preserve native fallback, top/private and Command+9 behavior. Its native workspace fingerprint changes. Source and isolated-world fixtures do not prove physical macOS key dispatch.

Merged PR #12 adds a bounded Google Docs canvas-editor input path. Its update-sheet entry stays in the pending-verification section: the source/fixture repair does not establish authenticated Docs typing, persistence, provider or native acceptance. Do not replace that entry with a live-site success claim until the combined-build checklist passes.

PR #13's narrow native Enter fallback also merged after explicit user instruction. Include its source in the next combined plan, but hold its runtime release copy until the Blink, patched-browser, native picker and IME/site checks in the inventory pass. Keep the existing Microsoft Enter limitation unchanged.

Merged PR #14 adds persistent Organato opt-out to the setup row and fully removes the disabled Organato sheet in the task-links row. Its native acceptance must confirm storage changes reaching real open new tabs and no helper process launch while off. The switch mirror is `organato.switches.v1` with `enabled` and `dashboardEnabled`; it is a fast-path copy of helper settings, not a second source of truth. AI-sidebar Organato behavior stays unchanged.

The merged feature batch is now included in the completed combined PC compilation. Native invocation and feature-specific acceptance remain separate gates, including the Settings command through the hub to All settings. Sync PR #6 is merged and its native files compile; encrypted two-profile/password acceptance remains pending, so working sync stays outside shipped claims.

The fuller performance/lifecycle details and the post-build benchmark workflow are mapped in [the 1.2.0 inventory](release-1.2.0-inventory.md). After final combined-artifact measurements, retain the strongest supported findings and the complete results table in the measurements disclosure after the feature tour. Keep workloads, comparators, units, conditions, regressions and unavailable results explicit; do not promote old component measurements or compilation throughput into browser claims.

The setup illustration follows the real guide's step sequence and links to `workspace.html#/welcome`. The storage illustration distinguishes active, ended and older sessions. Keep descriptions beside the artwork so their meaning remains available to screen readers. Earlier editions and patch drawings remain in Git history.

Release preparation now sets the extension, native display and packaged app version to 1.2.0 from `release-info.js`. The browser fixture also verifies that edition. The benchmarked private candidate predates that final version stamp and remains labelled with its actual metadata. The managed performance candidate includes the prepared ad-block-list experiment; retain that release note only if the final build enables it and passes its promotion checks. Feature acceptance, signature-copy cleanup and the final versioned release artifact remain separate checks.

The feature tour follows the masthead; the results section follows the features and precedes patch notes. A closed measurements section keeps detailed charts and methodology available after the feature tour. Its headline charts show selected measured wins with exact comparators; Full results retains all 11 browser measurements, component results, regressions and unavailable values. `efficiency.html` is a separate, read-only article linked from the update log. It reuses `whats-new.css`; the extension now fills all 50 reserved resource slots. Adding another resource requires revisiting that allocation.

## Page contract

- Load local assets only: system fonts, `icon128.png`, CSS/HTML artwork and inline SVG. No remote fonts, scripts, tracking or requests.
- Keep explanatory artwork `aria-hidden`; put the meaning in adjacent headings and text. Use fictional shapes rather than private browsing or account data. Illustrations explain behavior and are not verification screenshots.
- Keep HTML CSP-safe: external scripts, no inline event handlers or style attributes. Use `textContent` for dynamic text.
- `whats-new.js` accepts only a plain `x.y.z` release string. Missing or malformed metadata falls back to `Breezer` without breaking actions.
- Continue browsing removes the current tab through `chrome.tabs`, then falls back to `window.close()`. If closing is refused, show the close hint. Open Settings is a same-tab link to `workspace.html#/settings`.
- Keep the page light in dark mode. Preserve visible focus, narrow-screen layout and forced-color support. Automatic motion must respect reduced motion.
- The page itself stores nothing. Seen-version storage belongs to `release-notes.js`.
- Describe shipped behavior accurately. Website Touch ID passkeys still require Apple-approved signing entitlements; keep that limitation distinct from password suggestions.

## Verification

From the repository root:

```sh
node --test tests/ai/whats-new.test.mjs tests/ai/release-notes.test.mjs
BREEZER_AI_EVIDENCE=/tmp/breezer-whats-new node --test tests/ai/whats-new-browser.test.mjs
```

The browser fixture uses headless Chrome, synthetic release metadata and a stub for tab-closing APIs. It checks desktop and 390px layouts, contrast, keyboard focus, action fallbacks, reduced motion and malformed metadata. Inspect its overlapping viewport screenshots and scroll-position indexes, including every new illustration and the expanded technical disclosures. A single very tall HiDPI capture can repeat compositor tiles. Report skips as missing coverage.

These checks do not verify the compiled extension or updater. A release also needs the native build, actual-app checks and artifact verification in [RELEASE_POLICY.md](../RELEASE_POLICY.md). Native acceptance must respect the local-install hold.
