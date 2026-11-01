# 1.2.0 coverage and final measurements

This is the release coordinator's working inventory, not a publication claim.
The bundled [update sheet](../features/ai/extension/whats-new.html) is the
user-facing update changelog. Follow [the page contract](whats-new.md) and
[release policy](../RELEASE_POLICY.md).

The combined PC source now includes all nine merged feature/fix integrations.
Its last native pass completed at 23/23 with no failed actions; the app and driver
were copied and hash-verified on this Mac. The matched v8 browser comparison
completed 36 scored launches and 18 untimed setups. The final version stamp and
update-page changes follow that measured snapshot and still need a versioned
release artifact. Preserve all PC source, flags, outputs and caches. Mac
compilation remains stopped.

## Coverage

| Improvement | Update-sheet coverage | Remaining acceptance |
| --- | --- | --- |
| First-run setup, name, layout, appearance, color, import, Organato and tour | Setup row | Final compiled first-run, persistence, native imports and existing-profile behavior |
| Add shortcuts from a URL or open tab; keyboard selection; Remove/Undo/Restore | Shortcuts row | Final compiled new-tab and native input routing |
| Lazy favorite/pin Command-number activation and repeat dedup, PR #11 | Shortcuts details | Physical native dispatch, focus/auto-hide, windows/spaces/restart and fallback checklist; native fingerprint changes |
| Organato Upcoming assignment links open the task's own page | Task-links row | Final packaged host and actual integration |
| Fully remove disabled Organato and avoid new-tab helper/network work, PR #14 | Task-links details | Real open-tab storage propagation, helper process absence while off and re-enable behavior |
| One-click persistent Don't use Organato in setup, PR #14 | Setup details | Real helper confirmation/failure, summary and restart acceptance; Keychain key preserved |
| Ignore stale sidebar snapshots after close/title/activation events | Sidebar row | Final native sidebar acceptance |
| Indexed saved-session matching and sidebar model construction | Sidebar details | Final component rerun, combined runtime and large saved-workspace checks |
| Preserve unchanged sidebar rows and keyboard focus | Sidebar details | Final compiled sidebar interaction |
| Start helpers on demand and retire them after idle | Helpers row | Final artifact process-lifetime checks |
| Share Organato helpers across clients while keeping requests separate | Helpers details | Final multi-client, close/cancel and reconnect checks |
| Load AI provider/controller code only on demand | Helpers details | Final packaged host startup checks |
| Recover Settings clients after idle worker retirement without losing input or replaying changes | Helpers row | Final long-idle client checks |
| Retain checked updater candidates and installation handoff; reconnect safely | Helpers row | Final update startup, lifetime, failure and rollback checks |
| Reuse validated prepared built-in filter lists, with ordinary fallback | Storage row | Conditional performance promotion, unchanged custom/update behavior and final filter checks |
| Remove abandoned signature clones using ownership leases; retain live, legacy and ambiguous copies | Storage row | Final native component, process-death, ownership and storage checks |
| Restore native password-suggestion dismissal behavior | Passwords detail and limitation | Actual Microsoft Enter behavior remains unconfirmed |
| Local passkey-management route and accurate availability guidance, PR #7 | Passkeys row | Native WebUI/runtime acceptance; Apple entitlements still block platform-enrollment claims |
| Explicit selected-tab text research, PR #8 | Research row and capture details | Native dispatch/gesture/window lifetime and live provider acceptance |
| Page translation, restoration, controls and bounded dynamic text, PR #9 | Translation row and provider requirement | Native menu/shortcut/permissions, hosted authentication and real app acceptance |
| Settings category layout, search, keyboard/history and Other, PR #10 | Settings row | Native Settings command routing and real macOS rendering |
| Bounded Google Docs editor input path, PR #12 source/fixture repair | Pending-verification block only | Authenticated disposable Docs, actual input/save/follow-up behavior, both providers and native grants/runtime |
| Narrow native Enter fallback for explicit username/current-password POST forms, PR #13 | Source inventory only; runtime copy held | Blink unit target, patched disposable browser, native picker/IME/keypad/focus/validation/multi-step checks |
| Apple Silicon profile-guided candidate build with existing hardening retained | Build inventory, final measurement notes | Compilation, artifact identity and measured benefit; not an accepted runtime speed gain yet |
| Merged encrypted-vault setup, provider transport and workspace adapter, PR #6 | Pending-verification note | Native files compile; encrypted two-profile/password, wrong-key and recovery acceptance remain pending; passkey sync excluded |

The nine recent merged integrations are accepted into the source/draft inventory
and combined compilation, not a published or fully accepted release. Keep their limitations visible.
Prepared filter promotion remains conditional; remove its release claim if it
does not pass the final checks.

Sync PR #6 is merged. Its source and native compilation are verified, while
working encrypted two-profile/password sync remains outside shipped claims
until the acceptance checklist passes. Passkey sync is excluded.

Actual thread ownership, PR heads, merge evidence and limits live in
`build/release-1.2.0-feature-handoffs.json`. Update this inventory and the public
draft after each accepted merge. PR #14 corrects the inherited visual-polish
slot expectation to distinguish eight sites from the Add-shortcut tile. Its
owner reports the full suite at 292 passed, zero failed and one live-translation
skip. Rerun the final combined source suite after performance work is composed;
do not rewrite the earlier recorded failures as if they never occurred.

For merged PR #12, use the later combined browser with both providers, a
disposable profile and a new disposable Google Doc. Verify caret typing,
navigation/selection and a follow-up request without re-enabling tab consent;
confirm saved changes. Check sidebar/page Stop, frame Escape, tab/window
changes, navigation/reconnect cleanup and ordinary-control/research regressions.
Synthetic canvas/editor-frame evidence is separate from actual authenticated
Docs input consumption, persistence and native/provider acceptance. Until these
pass, use only the pending-source-path wording on the update sheet.

PR #13 merged as `d1c74e9291c4c804f6ed843132cc53c11286335d` after Ethan explicitly
overrode the earlier draft merge hold. Native acceptance remains a release gate,
and its runtime update-sheet copy stays held. Its concrete native gate is to
compile `blink_unittests`, run
`--gtest_filter=HTMLFormElementTest.BreezerLoginEnter*`, then run
`BREEZER_TEST_BROWSER=/path/to/disposable/Breezer node tests/passwords/enter-browser.mjs`
without `--baseline`. Also check the native saved-password popup's first Enter
selection and second Enter submission, IME commit/keypad Return, validation,
focus and multi-step/2FA with disposable data. Report actual native evidence back
to the parent when a later authorized combined or configured isolated build is
available. The stock-Chrome baseline deliberately lacks the enhancement and is
not working-after evidence. No universal or Microsoft sign-in success claim
follows from the merge. No extra heavyweight build is authorized now.

## Benchmark gate and order

Ethan requested the strongest measured findings at the **top** of the update
sheet, followed by a **complete results table**. Its insertion point is after
the masthead and before feature rows. Populate it after the final combined
artifact is runnable and verified. Do not substitute the current partial build,
old 1.1.5-versus-Chrome results, component diagnostics or compilation pace for
final 1.2.0 measurements.

1. Finish and verify the frozen build without discarding completed work.
2. Assemble accepted merges with existing performance/storage changes in a new
   pinned combined source plan. Preserve prepared caches and all earlier fixes.
   Build and verify that actual artifact; do not inject edits into live work.
3. Verify resources, versions, native/host identity, signatures and runtime
   acceptance. Keep the installed app and personal profiles unchanged.
4. Run the existing same-session three-way protocol from
   [browser-benchmark.md](browser-benchmark.md), comparing the final candidate,
   previous Breezer and Chrome on the same Mac. Use disposable profiles and the
   same fixtures, flags, initialization and foreground gates for every app.
5. Use six balanced rounds, three repetitions, ten fixture tabs, five seconds
   settling and five memory samples. Enable initialized profiles and physical
   footprint, protocol `installed-browser-v8-initialized-three-way-footprint`.
   Run on AC after competing builds/tests stop. Record OS, hardware, app and
   executable versions/hashes, fixture hash, timing endpoints and failures.
6. Re-run relevant component/lifetime checks separately. Their workload and
   baseline must stay distinct from whole-browser comparisons.
7. Inspect complete raw reports and artifact/runtime results. Select only
   robust, useful findings for the lead; include neutral results, regressions,
   failures and unavailable values in the full table. Update the performance
   copy tests to require this evidence before allowing numerical claims.
8. After the reports are accepted, delegate the short efficiency article to an
   Opus 5.5 subagent, medium effort with Fast disabled, in a T3-isolated
   worktree. Check model capabilities at launch. This is a subagent, not another
   top-level thread; do not launch it before benchmarks are ready.
9. Review the article against source and raw evidence, integrate it into the
   separate linked article page, and verify the final layout. Complete the benchmark-driven
   update-sheet and website presentation, then finish release policy checks.
   No publication or local installation follows automatically from this
   inventory or benchmark authorization.

## Short efficiency article after benchmarks

Ethan requested a small article on the updates page, mainly for his own reading,
explaining what we changed to achieve the efficiency gains. Aim for roughly
250-400 words in plain language, on a separate page linked from the update log.
Explain reduced repeated workspace work, unchanged-row reuse, on-demand/shared
helpers, provider loading, prepared filters and the final native build choices
where supported by the accepted source and measurements. Separate storage
cleanup from runtime CPU or memory results.

Give the Opus subagent the final artifact/source/profile identity, complete
benchmark reports, conditions and component/lifetime evidence. It should explain
what the measurements support and any trade-offs, without assigning a precise
share of a combined improvement to an individual optimization unless separately
tested. Compilation throughput is not browser efficiency; RSS is not unique RAM
or battery life. Preserve neutral, regressed and unavailable findings.

The Opus article and graphics drafts are complete. The coordinator checks their
evidence, integrates the article as `efficiency.html`, and runs desktop/narrow
page checks. Selected wins lead the update log; a closed full-results section
retains all measurements and limits. The tracked evidence is under
`docs/evidence/performance-1.2.0` and the article is `docs/efficiency-1.2.0.md`.

## Complete table contract

The final table needs columns for metric, unit, final Breezer 1.2.0, previous
Breezer, Chrome, repetitions/range and interpretation. Include each metric below
when available; explicitly label unavailable or failed observations and explain
why. Never convert missing coverage into a zero or omit a regression.

| Metric group | Rows required | Interpretation |
| --- | --- | --- |
| Startup | Initialized-profile startup; subsequent reused-profile startup | Same verified foreground endpoint; neither is an OS-cold launch |
| Tabs | Blank-tab readiness; product new-tab readiness | Programmatic creation and document readiness, not physical shortcut latency |
| Navigation | Local fixture readiness; local loadEventEnd | Separate host elapsed time and page navigation clock |
| Memory | One-tab and ten-tab process-tree RSS | Shared pages may be counted more than once |
| Native memory | One-tab and ten-tab macOS physical footprint | Separate metric from RSS and resident RAM; complete identity-valid captures required |
| CPU diagnostics | One-tab and ten-tab observed CPU-window results and coverage | Lower-bound observation with uncertainty; unavailable cases stay unavailable, no battery/energy claim |
| Components | Saved-tab restore sizes, sidebar construction/DOM work, helper/module lifetime, filter readiness | Separate workload-specific table with matching before/after inputs; no whole-browser multiplier |

Keep exact conditions and raw-evidence references adjacent to the table.
Highlights must identify their comparator, workload and unit. A faster local
fixture does not prove faster internet browsing, and a smaller process-tree RSS
does not prove longer battery life. Current measurements in
[performance.md](performance.md) remain historical/component evidence until the
final protocol reruns.
