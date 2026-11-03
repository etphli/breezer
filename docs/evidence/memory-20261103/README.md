# Continuing efficiency work

The user requested continued optimisation, with GPT-6.1 Sol subagents at high
reasoning and regular speed. Five disjoint feature audits were started with
`reasoningEffort=high` and `serviceTier=default`. The initial feature inventory
contains 107 files and 20,829 lines. Inventory is not review coverage. The ledger
checks reported line ranges and source hashes, and records pending or changed
sources. Vendored Chromium, generated output and marketing sites are excluded
from this authored-feature inventory.

All five initial feature audits are complete. The first covered native
integration, sync and the opt-in compiled filter experiment. The other reports
cover the workspace, page tools, extension services and native host. Changed
sources need fresh coverage. The first build-tool audit read 62 files and the
even-index verification audit read 47 files. The remaining verification half,
new files and the added C probe remain open.

## Folder-state restoration

Reconciliation previously searched every local pinned list separately for each
remote folder. The production-code fixture with 1,000 folders read 500,500 local
pins. The candidate reads 1,000, preserving expansion state. It stops scanning a
space once all relevant folders are found, and skips local pins entirely when
there are no remote folders. This avoids adding full-list work to the cheap
zero-folder and early-match cases. The first match within the last matching
space still wins, matching the previous duplicate-ID behavior.

`folder-model-before.tap` reproduces the excessive reads with a regression test.
`folder-small-case-before.tap` caught unnecessary scanning in the first candidate;
that candidate was refined before acceptance. The final sync tests cover the
large and small cases, fallback expansion and duplicate matching behavior.

## Unchanged recovery writes

An unchanged sync cycle previously wrote the complete local recovery object
three times. The new guard compares each proposed capture against the last
persisted serialized value and skips identical writes. Changed local edits still
reach recovery storage before an exchange, merged remote changes are captured
before application, and changed workspace data is still committed. Fault tests
cover failed exchange, failed local application, retry, quota failure and
appearance policy refusal.

The production-JavaScript probe observes zero storage writes for an unchanged
cycle, with identical saved data and no extra exchange. For its 1,000-entry
fixture, the baseline submitted 1,158,807 serialized bytes across three calls.
These are fixture submissions, not physical disk bytes or native browser RAM.
The comparison holds one serialized recovery snapshot for the current cycle;
CPU time and peak-memory tradeoffs still need review and measurement. No
whole-browser efficiency improvement is inferred from these operation counts.

## Disposal and alarms

A cycle awaiting its native bridge could recreate the repeating alarm after
disposal cleared it. The candidate checks disposal after the cycle and clears
an alarm whose asynchronous creation finishes after disposal. Three old-source
tests failed: disabled-workspace completion, configured completion and delayed
alarm creation. All four disposal cases now pass, including the already-correct
disabled-sync path. Sync cadence and native refresh behavior are unchanged.

## Reproduce and handoff

```sh
node script/verify_workspace_sync_efficiency.mjs --expect-optimized --output build/efficiency-20261103/sync-after.json
node --test tests/sync/lifetime.test.mjs tests/sync/reconcile.test.mjs tests/sync/workspace-model.test.mjs tests/sync/provider.test.mjs
python3 -m unittest discover -s tests/windows -p '*_test.py' -v
python3 script/windows/prepare-efficiency-packet.py
```

The probe accepts `--source-dir` to run the same assertions and counts against
an isolated baseline module directory. Before/after reports record all three
module hashes. The final sync suite passes on Node 22.14.0 and the packaged
Node 24.22.1 runtime. The migration/supervisor suite passes 25 tests locally;
one additional Linux-only test remains skipped until the PC is available.

The current packet checks nine extension resources before writing any of them.
Their baseline pins match the cached PC plan. Migration tests cover corrupt
packets, changed source and changed pins for both new resources, idempotence,
interrupted updates, backups and preserved object/source mtimes. The packet is
local and undeployed. Its native-helper receipt remains a separate packaging
gate. See [the PC runbook](../../pc-build.md#prepare-the-unattended-memory-build).

No PC contact, scheduling, native app build, installation, profile change or
compiled-cache deletion occurred. Native measurements, broad feature acceptance
and the remaining source audit are open. The canonical decision trail remains
[the November 2 log](../memory-20261102/decisions.tsv).

## Further implemented changes

`patchMembers` now reads, normalizes and compares only membership state under
the existing shared Web Lock. It retains session rollover and changed-write
suppression. Saved pins are never requested or serialized by this path. The
agent's differential fixture checks persisted values and write ordering across
24 cases, including overlapping instances. The coordinator's workspace browser
suite also passes against the combined source.

Translation checks the existing translated record before visibility. Unchanged
text therefore avoids rectangle/style reads after dynamic mutations. Changed or
new text and every write retain the original eligibility checks. Moving all
WeakRef pruning to traversal completion was rejected because it changes Restore
after detach/reattach. The original per-batch pruning remains. Differential tests,
the full disposable-extension fixture and isolated-world real-GC check pass.

Claude structured-output streaming now processes new input incrementally rather
than parsing every accumulated prefix. The original exported one-shot helper is
unchanged. Old/new round fixtures compare emitted deltas and final results,
including split escapes and multiple blocks. No real provider was invoked.
Independent review found a malformed overlapping-key compatibility gap. The
coordinator fixed it; the adversarial differential now has zero differences in
28,057 comparisons. The original review records the earlier source hashes.

The assistant's streaming renderer retains complete blocks after a blank line
outside code fences, and rebuilds only the unfinished tail. Finalization still
uses the full safe renderer. Prefix-by-prefix differential tests pass; the real
panel fixture now also checks committed-node identity, reader position,
bottom-following and final DOM equivalence at 320/400-pixel widths, including
reduced motion. Uninterrupted paragraphs, lists and open fences still require
full-tail work and add a line scan. Those cases have no claimed speed gain.

Same-bucket new-tab resize events skip shortcut reload/filter/paint work.
Breakpoint changes, storage changes, Reset and retry after failure remain
covered. A delayed initial filter test caught an inherited stale-width race;
the candidate refreshes the latest site count before completing initial load.
A later review also found an older asynchronous filter could overwrite the newly
loaded shortcuts. The load revision now invalidates that older result. All three
new-tab browser cases pass after this fix. Expired sidebar Undo clears its callback,
releasing the latest retained restore action; clicking an active Undo still
invokes it before the callback is released.

The combined offline suite passes 346 checks on pinned Node v24.22.1. Sequential
workspace, new-tab, translation and panel browser checks pass. The translation
suite's live-provider case stays skipped, and native/browser-wide performance is
not measured. The current packet now includes nine extension resources. Its
post-build host receipt verifies all eleven packaged JavaScript modules, including
the new Claude parser, with eight focused receipt tests and five archive/bundle
tests passing. The supervisor/migration suite passes 25 tests with one
Linux-only skip.

The independent sync review found no introduced correctness defect. Its byte-count
correction is applied above. Its artificial partial multi-key write scenarios
also exposed an inherited recovery limitation; actual Chrome partial-commit
reachability was not established. The failed-apply regression test covers rejected
writes, not arbitrary crash atomicity. Storage submission counts remain distinct
from CPU/peak-memory savings.


## Review fixes and failure recovery

[The resolution record](review-resolutions.json) links each corrected finding to
its current source hashes and local checks. The original reports retain their
reviewed hashes and findings rather than being rewritten as reviews of later code.

Organato response reading preserves pinned Node's removal of two leading BOM
characters. Rejected reads initiate cancellation without waiting for a stalled
underlying cancellation promise, and release the reader lock. Exact limits,
UTF-8 splits, replacement characters, extra BOMs and stalled/rejected cancellation
are covered by the combined offline suite. These checks do not invoke Organato
or Keychain.

The supervisor continues handling stop requests after a live worker closes its
output. Resource migration writes the exact bytes validated in preflight, even
when the staged packet changes afterward. Both fault cases pass in the 26-test
Windows preparation suite, with only Linux orphan adoption skipped on macOS.

The stream-render baseline is now an authored, hash-pinned fixture. Missing local
build artifacts can no longer silently turn the baseline check into zero
assertions. All nine workspace fixture callbacks close their owned loopback
servers after launch or browser-close failure. Provider fixtures register cleanup
before token reads and reap children after failed readiness, spawn failure or an
ignored first stop signal. Nine Node cleanup/provider checks and three Python
overlay checks pass. The real workspace route browser case also passes after the
cleanup change.

AI overlay downloads use a temporary file and atomically publish it only after
curl succeeds. The interrupted-download negative control failed before the fix;
retry and cache reuse now pass without network access. Existing cache entries
retain their prior provenance. A full offline overlay run was attempted but
could not start because its pinned source fixture is absent in this checkout.
That missing-fixture result is preserved in `overlay-offline-review-fixed.log`.

Measurement-schema validation, diagnostic child cleanup, independent review of
Codex setup cancellation, the remaining source audit and native PC acceptance continue. No published
whole-browser saving is inferred from these fixes.


## Codex setup cancellation

Cancellation now reaches the probe and runtime from the moment each owned RPC is
created, including initialize and thread/turn startup. Setup settlement is drained
before its isolation directory is removed. Queued tool callbacks and late replies
stop after cancellation. Normal chats still execute the tool-registry, reasoning,
speed and credential-absence preflight each time.

The delegate's 34 new fake-process cases pass. The coordinator's focused run
passes 92 checks including the existing Fast isolation case. A further actual
JSON-line transport check uses an owned Node child with an empty environment and
no provider. It ignores SIGTERM; shutdown escalates to SIGKILL, observes process
exit and only then cleans isolation. The 220-check combined offline run and eight
host receipt checks pass. The refreshed local packet includes the new Codex bytes.

Verification incident: the delegate initially ran an inherited test that created
and removed a temporary symlink to the default auth path. Inspection confirms the
test reads generated configuration, and neither it nor isolation reads auth
contents. The coordinator changed the test to use an owned dummy auth file and
assert that exact link target, restoring the original environment afterward.
Future complete runs include the hermetic test rather than excluding it.

[The integration record](codex-cancellation-integration.json) binds these checks to
exact hashes and retains the delegate's original report. Real provider operation,
physical RAM/CPU, partial isolation-allocation failure and cancellation during OS
bind remain unverified. Slow real process exits can still overlap replacements
allowed by the unchanged controller. Independent review of this larger lifecycle
change found no actionable introduced correctness issue; 75 focused checks passed.


## Measurement validation and remaining test-source audit

All 60 historical transport trials pass tightened schema, PID/runtime, native
status/identity, numeric-range and metric-delta validation. Raw reports, medians
and ranges remain unchanged. These are still Nov 2 measurements. Their single
native capture after the IPC samples cannot establish native process identity
throughout the earlier sample interval. Future probe-enabled runs bracket those
samples with matching PID, start identity and executable UUID. Clock values with
different units are never compared.

The diagnostic keeps its watchdog until observed child close, escalates failed
shutdown to SIGKILL and awaits reaping. Nine lifecycle/producer tests and six
summary tests pass. Escalation has a deadline; observed close still depends on
the operating system. No new performance benchmark was run. Tests use preserved
historical reports and summary under docs/evidence so an ignored local build tree
is not required.

The remaining verification-source audit read 53 files and 8,636 lines in its
frozen scope. Its two inherited findings are fixed. Six additional browser
harnesses now protect startup and close their server even when browser close
fails. Fourteen cleanup-checker cases pass. Settings focus assertions now compare
node identity; a failing-before regression and all 18 settings cases pass. Normal
browser suites were not rerun for these cleanup-only test edits. The complete
source ledger still records pending and changed hashes rather than claiming every
current source has finished review.

[The integration record](transport-and-audit-integration.json) preserves the exact
checks, changes and limits. Runtime optimisation continues with sidebar event work
and investigation of idle settings integration ports.


## Sidebar events and snapshot candidate containers

The sidebar skips drawing only for an autoDiscardable-only update whose remaining
full tab snapshot is equivalent. Every relevant event still updates state and its
version; pin, URL, mixed/unknown-field, shared-object and stale-query paths retain
their original behavior. Thirty-nine offline checks and all nine disposable
workspace browser cases pass. Twenty separated fixture events previously
scheduled/drew twenty frames; the new guard schedules/draws none while preserving
twenty version increments. This is a fixture count, not a production event rate
or browser-wide CPU result.

Page control snapshots now iterate the original static NodeList. They avoid the
eager full-size Array and Set, prioritize the Docs editor separately and suppress
its duplicate. The 180-successful-target cap, ordering, sensitive-field exclusion
and WeakRef identity are unchanged in differential fixtures. Twelve new cases and
56 combined page-control checks pass. Real browser control/redaction/input and
synthetic Docs editing/frame restrictions pass. Isolated-world real GC retains
zero extra detached nodes. The 10,000-control fixture reads 180 candidates rather
than 10,000; querySelectorAll still creates its complete static NodeList. No
physical RAM/CPU saving or whole-browser percentage is inferred.

The two page-browser harnesses also protect startup cleanup. Eighteen offline
harness failure cases pass. The initial Docs run hit an inherited pngjs resolver
problem with external Playwright; resolving from the supplied module path fixed
it, and the full synthetic fixture passes. No dependency was installed.

[The workspace/page record](workspace-page-integration.json) binds current hashes
and checks. Independent review is pending. The local packet is marked as needing
refresh while the separate CLI buffering implementation is in progress. Settings
port investigation found existing idle native disconnect behavior, so no port
lifecycle change was adopted.


## Fragmented provider output and refreshed packet

JsonLineProcess now searches each arriving decoded chunk before searching its
accumulated string. The original suffix loop, UTF-16 whole-chunk limit, ordering,
request/control correlation and cancellation behavior remain. Partial text is
cleared after confirmed child exit so a reachable closed transport no longer
retains that text. These are logical-reference and fixture results, not proof of
immediate physical memory release or browser-wide gains.

The pinned baseline is an authored fixture with a required hash. Tests no longer
require the ignored implementation receipt. Ten fragment tests also pass in an
owned temporary checkout containing only four required source/fixture files and
no build directory. The complete selected offline suite passes 342 tests without
skips. Eight packaging checks and six transport-summary checks pass. All packet
checksums and its nine extension/eleven host module hashes match current sources.
The packet remains local and undeployed.

The sidebar/snapshot independent review found no actionable introduced issue and
its eight reviewed hashes match. CLI parser review and the remaining current-hash
source coverage are pending. [The CLI integration record](cli-fragment-integration.json)
retains exact sources, commands, evidence and limits. Real provider/native-PC
acceptance and whole-browser RAM/CPU remain open.


## Independent CLI review

The parser review fully read all four files, matched their current hashes and
found no reachable production regression. Ten focused tests and 800 deterministic
differential cases pass. An artificial synchronous stdout data emission differs
from baseline, while normal pipe delivery and reentrant PassThrough writes retain
their order. Current Codex/Claude callers do not inject or synchronously pump
stdout from a message callback. This remains an explicit contract boundary.

The reviewer reported Python bytecode creation/refresh outside its allowed
artifact paths while importing the coverage checker. The cache was preserved;
subsequent Python work uses -B. No source, test or helper bytes changed. The
[review report](cli-fragment-review.json) preserves this execution deviation and
the exact semantic limits. Remaining current-version source audits continue.


## Current source coverage and final audit fixes

The frozen local ledger now covers every current authored feature/script/test
source in this inventory. The checker verifies reported read ranges, line counts
and current hashes; it does not certify absence of bugs or native performance.
Vendored upstream Chromium, marketing/advertising, documentation, generated
build trees and binary assets remain outside this scope. Later source changes
must be recorded as changed until their current bytes are reviewed.

The seven-file runtime audit found no actionable new regression. Remaining
build/test audit findings were reproduced and fixed by the coordinator. Cleanup
completion is recorded only after observed cleanup; transient discovery retries,
retained known group members, ownership reconfirmation and owned-worker failure
fallback prevent the skipped-final-attempt/frozen-worker defect. Permanent
OS/ownership uncertainty reports failure rather than claiming success. A real
owned worker and detached driver are reaped after an injected discovery failure.
Thirty build-preparation checks pass; one Linux-only orphan check awaits PC/WSL.
The staged cleanup fault suite also passes all five cases using the staged runner.

The standalone renderer probe enforces its pinned baseline. Dummy-provider helper
readiness waits for a complete line/port, and client disposal clears pending
requests/timers. A combined run exposed a one-millisecond clock difference in
baseline/candidate workspace fixtures; a shared controlled fixture clock fixes
that nondeterminism. The final combined Node run passes 346 checks, and all eight
packaging checks pass. The packet includes the cleanup tests and is refreshed
locally; no PC preparation/start, installation, user-profile or required
compiled-cache changes occurred.

The off-screen transcript-rendering experiment is rejected. Its resize-only
layout benefit does not establish general improvement: streaming medians worsen,
heap reduction is not established, and Find reveal/screen-reader acceptance is
unresolved. Production rendering remains unchanged. [The experiment report](panel-rendering-experiment-report.json)
and [final audit resolution](final-audit-fixes.json) preserve the evidence and limits.
Native PC/browser/provider acceptance and whole-browser RAM/CPU remain open.

## Native sync reply ownership

The native sync reader now transfers its validated owned ciphertext and revision
into the returned object. It previously copied both. The validation, error paths
and all other source bytes are unchanged. A source-bound diagnostic compiles the
actual conversion text against a small API type model. All 12 cases preserve
values and rejections; the original code fails the ownership-transfer check.
This is not a full Chromium build or a native RAM/CPU measurement.

The local PC packet now includes this one native source file alongside nine
extension resources and eleven helper modules. All ten compiled-resource input
hashes match the cached worker plan. Fourteen migration tests pass, including
interruption, unknown source/pin/packet refusal before writes, retained backups,
repeat-run mtimes and preserved compiled outputs. Twenty-nine sync checks and
eight packaging checks pass. All 29 packet file checksums match current sources.
No PC contact, deployment, build or installation occurred.

The current authored source ledger covers 284 files. This records read ranges
and hashes, not correctness or performance acceptance. Independent review of the
native conversion and migration found no actionable introduced issue. It repeated
the conversion, migration and packaging checks, plus 26 offline sync checks.
Provider HTTP fixtures were omitted under that review's no-network constraint;
the coordinator's earlier 29-check run included the local dummy provider.
[The review](sync-reply-review.json) and [implementation record](sync-reply-implementation.json)
contains exact sources, commands, counts and limitations. Generated-header
compatibility, the full native build and real provider/browser checks await the
PC candidate.

## Native reply framing

The final output encoder removes the temporary four-byte header Buffer and the
concatenation array. It preserves the existing payload Buffer, full payload copy,
UTF-8 conversion and output limit. This is a small reduction in per-reply
allocation overhead. It does not halve payload memory or bound the output queue.

Two one-buffer variants were rejected after both repeatedly slowed the 4 KiB
encoding fixture. The smaller change retains the existing conversion path. Its
120 paired local timing trials show improvement for the small-message fixture;
larger cases are close or have overlapping ranges. These are synchronous encoder
fixtures, not browser or normal AI latency measurements. Historical native helper
measurements and charts keep their original source/runtime hashes.

All 352 combined checks pass for the final production encoder. Six output tests
also pass with the completed diagnostic helper and in an owned four-file checkout
without a build directory. The old source fails only the allocation-budget check.
The existing decoder memory check and all eight packaging checks pass. The local
packet's 29 checksums and eleven host module hashes match current source bytes.
The [implementation record](native-output-implementation.json) retains raw
timings, logical allocation counts, rejected candidates and exact commands.

The authored inventory now has 287 files. Independent review fully read the four
current files and found no actionable introduced correctness issue. It adds
2,343 independent byte cases and 4,686 actual-allocation poison checks, including
pool boundaries and mutation controls. All four source hashes match, and the
current read-coverage ledger is complete. [The review](native-output-review.json)
retains timing noise, physical-memory limits and remaining native acceptance.
No PC contact, deployment,
installation or user-profile/required compiled-cache changes occurred. Native
output backpressure and whole-browser RAM/CPU acceptance remain open.

## Rejected decoder reuse

The lazy per-connection UTF-8 decoder prototype is rejected on current CPU
evidence. Behavior comparisons and completed-frame retention checks pass, but
the longer coalesced large-message fixture has a worse CPU median. Other cases
improve or overlap, so this does not establish a universal slowdown. It also does
not satisfy the requested acceptance gate. Production source and the packet stay
unchanged. [The experiment](decoder-reuse-experiment.json) preserves both timing
runs, source/candidate hashes, full Unicode checks, GC observations and limits.

## Rejected local backpressure prototypes

The blocked-consumer experiment reproduced growing native Writable buffers with
owned real stdio pipes. It rejects both local fixes. Gating the single ordered
provider stream delays later acknowledgments/control requests past their existing
deadlines. Async send promises instead retain the unconsumed messages in an
unbounded JavaScript queue. The 29 scenarios and six focused checks use frozen
production transport/controller code with a labelled fake provider and shortened
fixture deadlines, on Node 22.14.0. They are not real-provider or browser timing.

The [report](native-backpressure-experiment.json) records precise blockers,
source/scratch hashes, commands and owned-child reaping. A safe complete fix needs
verified demand handling by every producer and control progress independent of
blocked data, or a separate retention/overload product decision. No local patch
is adopted. Current provider security checks, timers, output order and data stay
unchanged; aggregate native queue growth remains unfixed.

## Window conversation lifetime investigation

The panel writes the last 60 nonempty messages under a window-specific session
key and reloads that key when the same window's panel opens. No matching closed-
window cleanup is present. Chrome documents that this storage stays in memory
until the extension/browser lifecycle clears it, rather than on window close.
[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
and [window ID/removal API](https://developer.chrome.com/docs/extensions/reference/api/windows)
are the primary contract references. Retention after closing windows is being
tested with synthetic data. No conversation data has been removed and no cleanup
is adopted. The [experiment](conversation-lifetime-experiment.json) confirms
retention but rejects its cleanup candidate. Synthetic same-ID restoration can
lose recoverable history, even after the modeled restored window becomes live.
Twenty-five checks include 1,171 bounded asynchronous schedules and 400 seeded
schedules. Actual browser restoration behavior remains unverified. All frozen
source files stayed unchanged; no real conversation data was touched.

## Plain-stream browser acceptance and integration

The [plain-text stream prototype](plain-stream-experiment.json) passes 112,920
visible-prefix comparisons and both ten-test fixture suites. Its full renderer
is byte-for-byte unchanged. A disposable browser experiment passed the isolated
gate, and the exact reviewed candidate is now integrated into source. Allocation
and parser-input counters alone do not establish browser CPU or RAM improvement.

The independent [source review](plain-stream-review.json) found no introduced
defect within append-only string input. It verified the exact restricted diff
and unchanged full renderer, and passed 1,035,147 additional visible-prefix
comparisons plus 20 prototype tests. The applied integration adds four focused regression cases for
retained Text identity/fallback/disposal, generated whitespace/control prefixes,
multi-block/fence boundaries and allocation/parser budgets. All 14 staged tests
pass for the candidate; the baseline fails three new fast-path checks. All 356
combined checks and eight packaging checks pass. The final standalone diagnostic
also includes a plain-paragraph case. The refreshed local packet's 29 checksums,
ten compiled-resource pins and eleven host module hashes match current source.

[Browser acceptance](</var/folders/6n/t9vh8ny53y986jmqgg3_4bsh0000gp/T/breezer-plain-browser-qc584rv9/report.md>)
uses Chrome 156 with an injected API fixture, synthetic providers and owned
profiles. Visible-prefix text/DOM, Blink window.find, held selection ranges,
accessibility text/roles, scrolling, pending RAF lifecycle and post-disposal GC
checks pass at the recorded sizes. Screenshots at 320 and 1280 pixels were
inspected. Browser Find toolbar, actual clipboard contents/paste and spoken
screen-reader behavior were not tested. Markup fallback/final rendering retain
the baseline selection reset behavior.

Warmed alternating foreground samples show useful plain-text throughput gains;
formatted/markup/numeric fallbacks are close or have overlapping timing ranges.
These forced-layout fixtures are not ordinary AI latency or whole-browser CPU.
A supplemental active-renderer heap check compares equal live text/DOM ownership
after GC. V8 and embedder heap medians are comparable; no physical process RAM
saving is established. Its first overly heavy repeated-layout harness was stopped
and retained, then a bounded one-final-layout run completed. Browser artifacts
remain outside the checkout, and [the integration record](plain-stream-integration.json)
links exact data, commands, hashes, corrections and limits.

The current 287-file authored source read ledger is complete. No PC contact,
preparation, start or scheduling occurred. Installed Breezer, user profiles,
credentials and required compiled caches remain untouched. Native app and
whole-browser RAM/CPU acceptance await the user-authorised build.

## Panel transcript work

The panel now resolves its first matching reply once per run and releases that
reference on finish. Incoming deltas and their RAF callback use the current run's
reference. Cold finish/stop/retry lookups remain. Recent-message selection scans
backward until it has the existing required count, keeping selected object
references and original order. History remains 30, persistence remains 60, and
the complete live transcript stays available. A sparse tail can still require a
full scan; this bounds the selected-result array, not all possible traversal.

All 364 combined checks and eight packaging checks pass. The canonical panel
fixture also passes in disposable Chrome with synthetic APIs and owned profiles.
The stream suite changes only its run initializer to match the real state.
The local packet's 29 checksums, ten compiled-resource pins and eleven host module
hashes match current bytes. No PC contact, deployment or installation occurred.

The [implementation](panel-efficiency-implementation.json) and
[coordinator checks](panel-efficiency-coordinator.json) retain exact hashes,
lifecycle proof, negative controls, write-order/value comparisons and logical
operation/result-array counts. These counts do not establish physical RAM or CPU
gains. The [independent review](panel-efficiency-review.json) fully read and hashed
the three current files and found no actionable introduced defect. It repeated
22 tests, added 228 offline checks, and confirmed that negative controls reject
the baseline. Run-start overhead, sparse traversal, inverse-patch maintenance and
runtime limits remain explicit. The current 288-file authored read ledger is
complete. Native/packaged acceptance and whole-browser measurements remain open.

## Sync size validation

Sync-model validation now uses UTF-16 string-length bounds before allocating a
UTF-8 byte array. Clearly fitting inputs skip encoding; clearly oversized inputs
keep the existing storage-limit error. Ambiguous sizes still use native encoding
to preserve the exact byte limit. JSON serialization, schema checks and their
ordering remain intact, including `toJSON(undefined)` behavior.

All 370 combined tests and eight packaging tests pass. Three negative controls
reject the old allocation path, an incorrectly skipped ambiguous check, and an
incorrect rejection at the exact limit. The local packet has been refreshed;
its 29 checksums, ten compiled resources and eleven host modules match current
sources and the cached plan's original pins. Nothing was sent to the PC.

The [implementation](sync-size-implementation.json) and
[coordinator record](sync-size-coordinator.json) preserve the native-reference
Unicode cases, exact hashes, logical allocation counters and limitations.
Serialization still allocates a string. These checks do not establish physical
RAM or CPU savings. The [independent review](sync-size-review.json) found no
blocking issue after 254 differential cases, 65,720 UTF-16 bound checks and the
focused tests. Its stale coordinator-status observation has been corrected. The
current 289-file authored-source read ledger is complete. Native app and
whole-browser acceptance remain open.

## Complete native input frames

The decoder now reads a complete unshared message body directly from the input
view. Fragmented and shared input retain owned copies. A malformed complete body
is copied before its error propagates, so changing the caller's buffer cannot
repair the decoder's recorded failure. Length, UTF-8 and JSON checks remain.
Production bytes match the independently reviewed candidate exactly.

The [prototype](native-complete-frame-experiment.json),
[independent review](native-complete-frame-review.json) and
[integration record](native-complete-frame-integration.json) retain exact sources,
timings, counters, failed trials and limitations. The review found no reachable
introduced regression after 66,437 new adversarial comparisons and the repeated
behavior/retention fixtures. Synthetic overridden-method and OOM behavior remain
outside that finding. Warmed CPU fixtures passed the recorded gate; physical RAM
and whole-browser gains remain unmeasured.

All 377 combined tests, seven focused tests on Node 22, and eight synthetic
packaging checks pass. Permanent tests cover copy avoidance, shared/fragmented
ownership, malformed-message snapshots and completed-buffer release. Negative
controls reject the original allocation path, retaining caller-owned error data,
and direct shared-buffer decoding. Two isolated actual-host stdio trials also
pass using settings rejected before configuration, credentials or network work.
Those trials do not establish transport performance or its chunk distribution.

The local packet's 29 checksums, ten compiled-resource pins and eleven host
module hashes match current sources. The authored-source read ledger covers all
291 current files. The [final integration review](native-complete-frame-integration-review.json)
accepted the permanent tests and packet without actionable introduced findings.
It repeated the seven checks on both runtimes, rejected five negative-control
variants and verified packet bytes, checksums and pins. Packaged/native app
acceptance remains open. No PC contact, deployment,
scheduling, installation or publication occurred.

## Rejected sync materialisation list reuse

The [list-reuse experiment](materialize-entries-experiment.json) passed its
behavior checks but failed its predeclared typical-workspace CPU benefit gate,
including the repeated measurements. Its heap snapshots also showed that the
shared list kept record-pair arrays alive longer at the inspected phase. That
snapshot is not a complete peak-memory or physical-RAM measurement.

The [coordinator decision](materialize-entries-decision.json) rejects adoption.
All 404 differential comparisons and 26 copied existing tests passed; the
compatibility corpus passed on Node 22. Production model/store hashes are
unchanged. Raw timings, snapshots, the candidate and its exact diff are retained.

## Rejected native checkpoint capture trimming

The [native checkpoint investigation](native-checkpoint-retention-experiment.json)
confirmed redundant callback captures, then rejected an optimization. Pinned
upstream declarations and serialization code show canonical checkpoints contain
UUID, generation and digest metadata, without entity data. Cached macOS-provider
size arithmetic puts the two canonical captured payloads at 102–198 bytes.
Accepted noncanonical input and other encryption providers have separate bounds;
actual profiles and their size distribution were not inspected.

The offline diagnostic passed ownership and identity assertions with synthetic
bytes. It did not execute Chromium callbacks, encryption, persistence or threads.
No production candidate was created, and all 1,339 protected repository hashes
remained unchanged. No CPU or physical-RAM benefit was established.

## Sidebar node index

The private saved-node index now stores each containing space directly, using
`null` for favorites. This removes unused per-node wrappers while rebuilding the
index on every operation. Favorites remain present bindings; missing IDs use
`undefined`. Public model objects, tab references, ordering and membership writes
retain their existing behavior in the checked cases.

The [implementation](workspace-index-implementation.json) and
[coordinator record](workspace-index-coordinator.json) preserve the exact six
source replacements, differential cases, logical construction counts, CPU gate
and limitations. All 381 combined checks, nine canonical browser-fixture tests
and eight synthetic packaging checks pass. The original source fails only the
new efficiency assertion while passing its three behavior tests.

The [independent review](workspace-index-review.json) accepted the change without
blocking findings. It repeated focused checks and adversarial cases on Node 22
and 24, and its isolated CPU recheck did not reproduce a material regression.
No general speedup or physical-RAM gain is claimed. The local packet now matches
the accepted source, with all 29 checksums, ten compiled-resource pins and eleven
host hashes verified. The current 292-file source read ledger is complete. The
PC and installed app remain untouched.

## Saved-pin matching experiments

Neither [initial matching candidate](pin-matching-experiment.json) is adopted.
Candidate A missed its CPU benefit gate and changed malformed-input outcomes.
Candidate B passed its CPU gate on ordinary data, but kept more live indexing
state during reconciliation and changed raw accessor/reentrant behavior.

The [coordinator decision](pin-matching-decision.json) holds the source unchanged.
The reported accessor counterexamples are absent from the inspected normalized
storage and native-tab callers. The
[requested-URL follow-up](pin-matching-targeted-experiment.json) tested that
boundary and a smaller index. It also remains rejected: its one-pin and empty
saved-store cases failed the predeclared CPU gate, and the smaller buckets still
retained more in-operation state than the baseline. Its differential, existing
test and corrected browser trials passed. Those component observations do not
establish whole-browser physical-RAM savings. The accepted source was frozen for
the authorized PC build without adopting any of these candidates.

The existing lazy-folder-row rejection remains in force because its browser
trials found an opening delay. It will not be repeated as a new optimization.

## Authorized PC build

Ethan confirmed the PC was available and asked to start the build after the final
checks, minimizing work. On November 3, the coordinator verified the packet's 29
checksums on Windows, passed all 14 supervisor and five cleanup tests in WSL, and
migrated only the ten pinned compiled resources. The existing graph, arguments,
Ninja journals and browser output passed before/after preservation checks. The
remote manifest was used as the migration base, preserving unrelated PC inputs.

The existing Windows task started at 16:38:21 Sydney time with the supervised
incremental launcher. At 16:44 Sydney time, the bounded snapshot confirms an owned
compiler and three completed actions out of the current 27-action estimate,
including the updated native sync object. No failures, paging or OOM kills were
observed in that sample. This is compilation and process evidence, not a completed
build or native acceptance result. Ninja's total can change during a pass.

The runner checkpoints every 10,000 observed finished actions, keeps independent
Ninja work going after failed actions, and retries confirmed resource
interruptions within its bounded policy. Failed actions still prevent success.
The existing 30-minute PC monitor is enabled, with its first check at 17:12 Sydney
time. The Mac and dual-machine monitors remain disabled.

Exact inputs, deployed hashes, preparation, test receipts, launch, bounded health
snapshots and monitor registration are under
`build/efficiency-20261103/pc-start/` in the active worktree. Its `handoff.json`
is the current status receipt and supersedes earlier historical statements that
the PC had not been touched. The installed app and user profile are unchanged.
Compilation, candidate packaging/runtime acceptance and whole-browser RAM/CPU
measurements remain open.

## Compile completion and counter activation

At Ethan's request, the existing interactive counter task opened the progress
window at 16:55 Sydney time in desktop session 6. Its form's activation receipt
records `visible=true`, the current process and `9/9`. The standalone reader
reports `Compiled`. The desktop counter remains open and does not start WSL or
the build.

The final Windows worker state records completion at 16:46:21 Sydney time,
`fullBrowserBuildProven=true`, and executable SHA-256
`49dd57e41577e1f67cfad2e0b38c812704a769f70fdb6e1171c22671be0f2185`.
The build task is Ready with result zero, and WSL was already stopped. The
30-minute build monitor was disabled before its planned 17:12 check.
`pc-start/verify-counter-final.json`, `open-counter.json` and
`monitor-stopped.json` preserve the evidence in the active worktree's build
directory. Cross-session window enumeration from the SSH session returned no
windows and does not establish visibility; the desktop form's own fresh receipt
is the visibility evidence. The new native output still needs retrieval,
packaging and Mac runtime/feature/physical-RAM acceptance. The installed app
remains unchanged.

## Packaged memory candidate

Ethan explicitly requested packaging all accepted changes. The new PC archive
was exported without rebuilding, transferred with a verified SHA-256 checksum,
and checked against the frozen native binaries. All 50 compiled extension
resources match the accepted source. The candidate also contains all 11 matching
native-helper modules and the checksum-pinned Node 24.22.1 runtime.

The separate arm64 app passes deep strict ad hoc signature checks and five
headless runtime smoke checks in a disposable profile. Those checks cover actual
component-resource serving, Settings and native API registration, the new-tab
page, and 705 streaming prefixes. Four packaged-host smoke checks also pass.
The disposable browser and profile were cleaned up. Real accounts, physical
input, spoken screen-reader behavior and whole-browser RAM/CPU measurements
remain outside these checks.

The generated `Breezer-1.2.0-memory-20261103-arm64.dmg` passed image verification
and read-only mounting. All 374 app file/symlink entries match the signed
candidate. Resource, helper, architecture and deep signature checks also pass
inside the mounted image. The image was detached. The
[package receipt](package-verification.json) records its SHA-256 and exact
verification scope. The app, DMG, checksum and build-information file are under
`build/efficiency-20261103/package/` in the active worktree. Signing is ad hoc;
the package is not notarized. No installation or publication occurred.
