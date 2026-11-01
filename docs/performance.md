# Performance work in progress

This work preserves the installed Breezer app, user profiles, passwords and
existing native build outputs. No release or installation has been made.

## Verified component improvements

Measured on this M1 Mac using Node 22.14.0. These are component measurements,
not whole-browser startup or general browsing speed claims.

| Workload | Before | After | Measurement |
| --- | ---: | ---: | --- |
| Restore 100 saved tabs | 2.61 ms | 0.57 ms | Median of 11 runs |
| Restore 500 saved tabs | 51.50 ms | 1.74 ms | Median of 11 runs |
| Restore 1,000 saved tabs | 194.18 ms | 2.93 ms | Median of 11 runs |
| Model for 1,000 sidebar tabs | 3.29 ms | 0.18 ms | First run; 20 model builds per observation |
| Native helper spawn to initialized module | 54.62 ms | 43.66 ms | 20 alternating paired observations |
| Native helper RSS after module loading | 53.20 MiB | 43.16 MiB | Same helper observations |
| DOM mutations in unchanged sidebar rows | 42 | 0 | Real browser fixture, same tab event |

Saved-tab restoration now indexes previous URLs and their assignment counts once
per operation. It consumes exact and path matches from both indexes, preserving
ambiguous-URL quarantine across windows. Sidebar model creation indexes saved
nodes rather than scanning the entire tree for every bound tab. The indexes do
not persist across mutations.

Rows retain their DOM when their visible fields have not changed. Active state,
titles, favicons, loading, discarded state, audio, actions and rename state remain
part of the comparison. Keyboard focus remains on the existing nodes.

A native sidebar review found one directly hosted extension document per window,
with no iframe wrapper. All 12 Breezer baseline launch inventories contained
exactly one sidebar document. The frozen PGO source matches the owned native view.
The hidden native tab strip remains necessary for controllers, anchors, drag
targets and failure fallback; this review did not justify removing it. Evidence
is `build/performance-20261029/native-sidebar-memory-review.json`.

Organato pages share one helper per extension background instance. It starts with
the first request and disconnects after all requests finish and a 250 ms idle
period. Sequential requests can reuse the connection; progress and overlapping
requests retain it. Each page owns its requests, so closing one page does not
cancel another page's work. A later request reconnects. The AI
provider/controller modules now load on the first AI request, so dashboard and
settings requests do not parse them. Provider discovery, permissions and model
validation remain intact.

Reproduce the session/model CPU benchmark with:

```sh
node script/benchmark_workspace.mjs /path/to/workspace-store.js
```

It uses synthetic saved records, not 1,000 live browser WebContents. The helper
measurement imports the real host entry, makes no provider discovery, network,
keychain or inference calls, and includes a separate spawn-to-result interval.
RSS is not unique physical memory.

A separate native messaging check opened a trusted settings port in a disposable
profile, submitted invalid settings and verified the real host's rejection. It
does not read Keychain secrets, change settings or call providers. Installed 1.1.5
kept one helper alive before requests and after both replies; its observed macOS
physical footprint was about 21 MiB. The candidate started no helper before a
request, released it after each reply, and reconnected for the second request.
The settings port remained usable. This verifies process lifetime on an error
reply, not successful Organato integration or a whole-browser RAM saving.

The r3 native candidate adds sharing across settings/new-tab connections. Six
real trusted settings connections from one document used six baseline helpers,
about 125.04 MiB combined physical footprint after replies. The candidate used
one helper at about 16.10 MiB, then zero helpers after idle. All six connections
received their own response despite identical UI request IDs; a later batch
started a fresh helper and succeeded. This is a functional, synthetic connection
workload, not six rendered settings windows or a whole-browser memory comparison.
Five focused lifecycle tests also cover progress routing, a page closing during
another page's request, and failure/reconnect after the shared helper exits.

A longer native check found a regression in r3: after 40 seconds of inactivity,
the extension worker retired and both settings clients kept disconnected ports.
The next action failed until Settings reopened. The r4 clients now reconnect on
the next action, preserve idle form input and status, and reject interrupted
requests without automatically replaying changes. Context settings also observe
their local storage key while their port is dormant, preserving live updates.
The exact packaged production-client check fails on r3 and passes on r4. It
confirms that the worker actually retired, no helper remained, the typed key and
status survived, a context notification arrived, and both clients worked afterward.
All 52 related source/browser-fixture tests passed. These checks use invalid
Organato payloads and disabled local context in disposable profiles, with no real
credentials, provider calls or configuration changes.

The read-only `script/macos_process_usage.c` probe uses macOS `proc_pid_rusage`
and reports physical footprint separately from RSS. Apple's footprint accounting
includes dirty, compressed and swapped memory; it is not a count of physical RAM
currently resident. See [Apple's memory profiling explanation](https://developer.apple.com/videos/play/wwdc2022/10106/).
A real 64 MiB allocation/release check increased footprint by about 64 MiB and
returned to its initial value; missing and invalid PIDs were also checked. The
probe records kernel start identities and capture bounds. Summing lifetime peaks
across processes would not establish a simultaneous app peak.

Reproduce the native bridge lifetime check with matching engine artifacts:

```sh
xcrun clang -O2 -Wall -Wextra -Werror script/macos_process_usage.c \
  -o build/macos-process-usage
node script/verify_breezer_helper_lifetime.mjs \
  --baseline-browser /path/to/baseline/Breezer.app/Contents/MacOS/Breezer \
  --candidate-browser /path/to/candidate/Breezer.app/Contents/MacOS/Breezer \
  --artifacts /path/to/compiled-filter-artifacts \
  --usage-probe build/macos-process-usage --clients 6 \
  --output /path/to/lifetime-report.json
node script/verify_breezer_settings_lifetime.mjs \
  --browser /path/to/candidate/Breezer.app/Contents/MacOS/Breezer \
  --artifacts /path/to/compiled-filter-artifacts \
  --output /path/to/settings-lifetime-report.json
```

The helper comparison samples 1.5 seconds of idle time between batches. The
settings-client check separately waits 40 seconds without attaching a debugger
to the AI worker, then verifies recovery after actual worker retirement.
It mounts only the production Organato and context clients. The r4 normal Settings
route also retained an updater helper and its worker. Its separate updater-port
control confirmed that limit. The r5 unused-port control instead requires no
native helper. Neither check by itself establishes full-page memory use.

The r5 updater bridge starts its helper on the first request and releases it after
an empty check or error when it has no checked candidate or active installation.
Pending requests, available releases and active installs retain the same host.
The install acknowledgement keeps it connected through polling until terminal
status. Settings reconnects on the next check after idle worker retirement;
unexpected disconnection invalidates Install and requires another check, without
automatically replaying installation. Release validation, worker startup,
checksum/identity/signature checks and rollback code are unchanged.

A signed r4/r5 native comparison mounted all three packaged settings clients.
For this diagnostic, updater payloads map to read-only native `update-status` and
Organato payloads to invalid input; it performs no release check or installation.
After 40 seconds, r4 retained one updater helper with a 16.05 MiB measured
footprint and one worker. R5 retained neither. Its status and typed key survived,
and both native clients and local context worked afterward. This removes a real
idle helper in that workload; it is not a full Settings page or whole-browser RAM
comparison. Available-release retention is covered by source tests, not this
read-only native diagnostic. All 70 adjacent tests passed, including worker
startup failure, timeout, runtime lifetime and rollback checks. The actual signed
upgrade and GUI acceptance remain unverified.

Reproduce this transport comparison with candidates from immediately before and
after the updater lifetime change, with matching compiler artifacts:

```sh
node script/verify_breezer_update_lifetime.mjs \
  --baseline-browser /path/to/before-updater-change/Breezer.app/Contents/MacOS/Breezer \
  --candidate-browser /path/to/after-updater-change/Breezer.app/Contents/MacOS/Breezer \
  --artifacts /path/to/compiled-filter-artifacts \
  --usage-probe build/macos-process-usage \
  --output /path/to/update-lifetime-report.json
```

The baseline is r4, not installed 1.1.5, whose Organato helper lifetime also differs.

## Current installed baseline versus Chrome

All six alternating paired rounds completed with 24 successful measured launches
on AC power. This uses the initialized-profile v4 protocol described in
[browser-benchmark.md](browser-benchmark.md). It is the baseline, **not a result
of the changes above**. Medians follow.

| Metric | Installed Breezer 1.1.5 | Chrome |
| --- | ---: | ---: |
| Initialized-profile startup | 583.2 ms | 577.2 ms |
| Subsequent reused-profile startup | 1016.0 ms | 1106.2 ms |
| Blank tab readiness | 68.4 ms | 64.4 ms |
| Product new tab readiness | 84.0 ms | 183.9 ms |
| Local navigation readiness | 49.4 ms | 35.6 ms |
| Local loadEventEnd | 12.6 ms | 6.8 ms |
| One-tab process-tree RSS | 1137.3 MiB | 1307.5 MiB |
| Ten-tab process-tree RSS | 2337.6 MiB | 2306.4 MiB |

V4 requested activation but did not verify the active/frontmost PID at the
startup endpoint. These remain historical v4 observations. The final v6 run
requires foreground proof after document readiness and reruns all three apps;
its startup endpoint is stricter and includes that verification's overhead.

Breezer's first navigation after exercising tabs stalled in every round, taking
810–872 ms. Later navigations were faster. The median must not hide this delay.
An untimed trace reproduced about 938 ms before requestStart and long extension
renderer tasks before the network job. A separate headless CPU profile of the
actual blocker found filter compilation, cache serialization and garbage
collection, with filtering ready after 1486 ms. This identifies substantial
blocker startup work; it does not yet prove the precise cause of the scored
navigation delay. Filtering has not been disabled or weakened.

Earlier v3 and v4 setup failures are retained separately. V4 initializes both
profiles and explicitly activates each launched process. Its startup numbers
cannot be attributed to optimizations by comparing them directly with older
fresh-profile reports. Small samples, shared-page RSS accounting, existing user
sessions and machine load limit the conclusions. No battery-life or comparative
CPU-efficiency claim is supported.

## Earlier benchmark records

The historical records were rechecked against their raw trials: 280 process-tree
RSS sample sums and 32 stored medians matched. All metrics, source commits,
artifact identities and input hashes are retained in
`build/performance-20261029/historical-benchmark-audit.json`.

Each cell below shows Breezer / Chrome. These are separate datasets; changes in
protocol, power and app source prevent a controlled before/after attribution.

| Dataset | Paired rounds | First-launch condition | First startup, ms | Ten-tab RSS, MiB |
| --- | ---: | --- | ---: | ---: |
| v1.0 report, source `65c8f4c` | 2 | Fresh, battery power | 2154.6 / 1287.9 | 3379.2 / 2513.4 |
| Earlier release-performance build, source `4fc90a3` | 6 | Fresh, AC power | 1157.2 / 823.6 | 2332.7 / 2504.6 |
| Installed baseline, source `a1e0491` | 6 | Initialized, AC power | 583.2 / 577.2 | 2337.6 / 2306.4 |

The v1.0 benchmark failed in round three; only its first two complete paired
rounds are included. Its partial ninth launch remains excluded. The newer
initialized-profile startup deliberately excludes onboarding work and must not
be presented as a startup speedup over the historical fresh-profile figures.
None of these rows measures the current experimental candidates.

Full historical results and limitations are in the
[v1.0 report](../build/benchmark-20261027-report/benchmark-report.md) and
[earlier release-performance report](../build/benchmark-20261029-report/benchmark-report.md).

## Blocker compilation experiment

The opt-in per-list reader returns the real compiler's existing text format for
unchanged bundled raw lists. It checks raw and payload hashes, bounded byte
counts, UTF-8, compiler/source and engine identity, capabilities, environment and
live trust. Every miss uses the ordinary compiler. Metadata, bad-list checks,
cache writes, updates, custom lists and the selfie-first startup path remain.

The actual built-in compiler generated deterministic output for 11 local lists.
All 167 compiler/runtime JavaScript files matched the prepared source. Live
checks returned byte-identical results for every generated list. The staged
production storage hook also passed seven cases covering hits, existing cache,
both bad-list checks, changed raw text, custom lists and empty input. Corrupted
payloads selected fallback. Ten bounded-reader tests passed.

Six balanced pairs of cold-engine reloads in one warmed, isolated headless
browser produced these medians. Forced garbage collection preceded each reload;
ordinary cache writes were retained. PGO compilation was active during this
diagnostic. These are not browser startup or app-RAM measurements.

| Component measurement | Compile raw lists | Bundled compiled lists |
| --- | ---: | ---: |
| Filter-engine readiness | 1915.15 ms | 928.35 ms |
| Cache writes complete | 1987.85 ms | 940.35 ms |
| CPU in observed stable process identities | 2.527 s | 1.304 s |

Observed CPU excludes processes born and exited between listings. After forced
GC, both paths retained about 15 MB of JavaScript heap and 8.83 MB of backing
storage. This is not a peak-memory result. A valid existing compiled cache or
whole-engine selfie can bypass this new reader, so it cannot yet be credited
with resolving the baseline navigation stall.

The generation, staging and verification tools are documented in
[features/performance/README.md](../features/performance/README.md). The real GRIT
check verified all 16 changed runtime resources, gzip bytes, a 672-resource total
within the 1,000-ID reservation, and unchanged list selection. The generated
payloads total 17.10 MB of text; compressed resources including the storage module
occupy 2.67 MB. Native filtering/UX, cold startup and peak RSS remain promotion
gates. The experiment remains disabled for ordinary builds.

## Packaged native result

A real native candidate now includes the compiled-list overlay, the three
workspace/bridge resources and the lazy host entry. Strict signature validation
passed. Its 170 compiler/runtime JavaScript resources matched staged source, and
the default reader fetched the real packaged assets. All 11 lists matched the
ordinary compiler byte-for-byte; changed text and trust settings selected fallback.

Six balanced pairs of fresh disposable headless profiles completed without
competing builds. Both apps used the shipping Chromium compiler environment and
identical selected-list sets. These measure cold filtering, including its normal
first-install extension restart, rather than visible-window startup.

| Native diagnostic median | Installed 1.1.5 | Candidate |
| --- | ---: | ---: |
| Filtering all-ready time from the background page's T0 | 1192 ms | 702 ms |
| Sampled startup process-tree peak RSS | 1450.34 MiB | 1453.80 MiB |
| Blocker JavaScript heap after forced GC | 13.45 MiB | 12.41 MiB |

Cold filter readiness improved by 41.1%. The sampled RSS difference is smaller
than the observed run-to-run variation, so it does not establish an app-RAM gain.
RSS is a sum of resident sets rather than unique physical memory; 100 ms sampling
can miss a peak. The small retained-heap reduction is specific to the blocker.
These results do not establish improved warm-cache or selfie startup.

These are the rebuilt r2 candidate's results. An earlier experiment introduced
an asynchronous race: a raw-list update could finish while a packaged read was
pending, then the older result overwrote the updated cache. A real native
reproduction failed for both concurrent reads and the final cache. The adapter
now observes raw-list changes and consumes its result synchronously with the
storage operation, retrying when the input changed. The exact reproduction passes
for both reads and the cache. The measurements above were repeated after this fix.

The same native build also passed 640 differential request decisions with the
reader enabled versus forced to miss. Positive and negative controls cover user,
custom and temporary filters, cosmetics and exceptions, scriptlets, redirects,
query removal, list update/reselection, bad-list suppression and live trust
changes. These functional checks do not substitute for final GUI acceptance.

Separate functional native checks confirmed that all 11 ordinary compiled-cache
hits bypass both the compiler and packaged reader. A real blocker restart restored
the existing saved-engine snapshot with the same 20 selected lists and 176,285
network filters from the offline fixture. The test waits for the existing delayed
asset-registry persistence before restarting. It does not change that behavior or
claim a warm-start speedup. The reusable native verifier also waits for its exact
owned processes to exit before removing temporary profiles.

The six-round GUI/Chrome candidate run failed during untimed setup, before any
scored launch. An untimed GUI reproduction showed filtering ready after 687 ms
while the requested page remained `about:blank`. A read-only process sample
identified the encryption-key worker blocked in `SecItemCopyMatching` and
SecurityServer IPC. The OS Keychain authorization requires direct user handling;
the Computer Use tool refuses SecurityAgent access. No encryption or trust check
was bypassed. The failed run is retained and must not become a benchmark score.

Final GUI acceptance will use the v7 three-app footprint protocol: installed baseline,
candidate and Chrome in all six app orders. Every app receives identical setup
and measurement steps in the same session. The earlier v6 revision passed twenty benchmark checks,
including position/pair balance and separate three-app summaries; both earlier
completed summaries reproduce exactly. V6 preparation against the signed r3
candidate, installed baseline and Chrome passed with no browser launches,
unchanged existing browser roots and all 369 installed bundle files unchanged.
The native probe also passed real inactive/active controls using an owned,
bundled AppKit fixture, then closed the fixture and restored the prior foreground
app. The legacy visibility gate accepted the inactive window; the strict gate
rejected it and accepted the active fixture with the same PID. AppKit polling
advances its main run loop, as required by the SDK's state-refresh contract.
The earlier unbundled fixture could not activate and remains failed evidence.
These checks validate the probe and preparation, not scored browser execution or
the unfinished PGO candidate. Evidence is `native-foreground-verification.json`
and `three-way-foreground-prepare-verification.json` under the performance
evidence directory; the prepared report is
`build/performance-20261030-v6-prepared/results.json`.

The optional v7 mode adds macOS kernel footprint reads alongside RSS while
retaining strict v6 foreground readiness and balanced app orders. It checks
the complete owned process tree around each capture and native PID start/UUID
identities in both reads. Partial captures, churn or unavailable counters do not
produce numeric footprint results. All 25 benchmark checks pass, including
no mixing of app/trial medians and no dropping of unavailable observations.
Completed historical v3/v4 summaries still reproduce exactly. A real two-process
diagnostic passed with the compiled probe; after one child exited, the capture
correctly became unavailable. This is measurement-tool verification, not an app
memory improvement. Final v7 scored browser execution remains unfinished.
The actual signed r5 browser also passed three functional headless captures of
all eight owned processes. Three-app preparation passed with no browser launches,
unchanged existing main browser roots and all 369 installed files unchanged.
The first outer preparation-inventory check also included helper processes
and failed when that broader process set changed. Its failure is retained; the corrected
wrapper matches each complete main-executable prefix and browser role. This
selector was separate from the sampler, which uses its launched root PID.

## Candidate and native build

The first isolated resource candidate was an APFS copy of the installed app with only
three extension resources and the native host entry changed. Strict signature
verification passed. Both native executables match the baseline after removing
signatures from temporary verification copies. The real candidate comparison is
pending macOS authorization. SecurityAgent took the foreground while its page
stayed blank; the Computer Use tool explicitly refuses to operate SecurityAgent.
The user has been asked to handle the OS prompt directly. The installed app was
not replaced.

The r4 native candidate adds the compiled-filter resources, shared helper
and settings reconnect fix. Relative to r3, only the existing `settings.js` and
`context-settings.js` packed resources changed. Their decoded bytes match source;
all other packed IDs and unsigned native code match r3, and strict signature
verification passed. Unrelated new-tab, Organato-host and password work is excluded.
The current r5 candidate changes only the existing `background.js` and
`settings.js` resources relative to r4 for updater lifetime and reconnect behavior.
All other packed IDs and unsigned native code match r4; strict signatures passed.

The `pgo-performance` experiment uses a separate source snapshot and output. It
adds Chromium's pinned ARM64 profile to the existing release-performance settings
without enabling official mode or ThinLTO. Generated commands show 46,520 PGO
compile actions, no DCHECK_ALWAYS_ON, and retained stack protection, initialized
stack variables, FORTIFY, libc++ hardening and the V8 sandbox. The generated V8
configuration has debug code off, pointer compression on and the sandbox on.
The PGO build was stopped at a recoverable checkpoint after roughly 15,200
actions while the narrower native candidate was built, then resumed. Its compiled
progress is preserved. Moving Siso caches to an isolated source/output invalidated
build-edge hashes even after rebasing recorded paths. Those attempts are retained
as evidence. The native candidate instead used a temporary overlay in the
completed prepared build, with exact backups and automatic source restoration.
All prepared blocker source hashes were restored and the baseline output was
rebuilt successfully. All 369 installed-app file hashes remained unchanged.
The PGO build hit its 3 GiB free-space floor and stopped with progress preserved.
It resumed with one compiler job. The initial soft 1 GiB Siso Go-heap limit caused
heavy garbage collection; the current build uses a soft 2 GiB limit, GOGC 100 and
two Go execution threads. These are build settings, not browser runtime changes.
The stopped source checkpoint was migrated to the verified r2 filter adapter;
the runner checks its overlay before and after compilation. The 3 GiB storage
guard remains active. PGO is not yet an accepted optimization.

After another storage-floor stop, two owned rebase diagnostic backups were gzip
compressed with full decompression/hash verification, reducing their logical
file sizes by 761 MiB. No live build cache or user data was removed. Free space
also rose while the system released swap; the compression's physical disk-space
contribution was not measured separately. The
source checkpoint was updated to the verified r3 shared helper, and compilation
resumed under the same storage guard. The signed r3 resource candidate changes
only the AI background resource relative to r2; all blocker resources and unsigned
native code match. The cold-filter table above remains the measured r2 result.

After the real long-idle failure was fixed and r4 passed, the PGO runner stopped
cleanly and its two existing settings resources were updated to the verified r4
bytes. The other three owned AI resources still matched r3/r4 exactly. The runner
now refreshes all five owned AI resources on resume. Compilation resumed with the
same output, compiler flags, storage guard and existing caches. This migration is
recorded in `native-pgo-settings-r4.json`; it is not a finished native build.

The next clean checkpoint migrated those two resources to the signed/native-verified
r5 bytes, with all five owned AI resources checked against both candidates. The
private completion packager now pins r5 resources and host/runtime files, checks
the installed bundle and refuses unfinished compilation. Its input preflight
passed; actual PGO packaging and runtime acceptance remain pending.

At that stopped checkpoint, 1,673 completed PGO object files received transparent
filesystem compression. Every file's SHA-256, logical size, mtime, permissions,
ownership and path were verified before and after replacement. Per-file allocated
storage fell by 199.1 MiB; free-volume changes also include OS activity. No object
content, compiler flag, live cache index, user file or installed app changed.
Compilation resumed in the same output. The diagnostic is
`cache-compression-1793298948652960000.json` with its per-object journal; cache reuse after
resume is checked separately. All 1,673 object hashes, sizes and mtimes still
matched after resume, and none appeared among the resumed step-start records
through the first 81 completed CXX steps. A separate whole-log audit found 17,445
completed CXX records and no duplicate outputs. Both are point-in-time checks,
not completion percentages. This is build storage work, not a browser speed gain.

A later storage-floor stop preserved the same build checkpoint. Once free space
recovered above the guard, another 73 completed objects were compressed and
verified, saving 10.0 MiB in per-file allocation. Across both batches, 1,746
distinct objects account for 209.1 MiB less allocated storage; every hash, mtime
and compression flag was rechecked. The aggregate is `cache-compression-summary.json`.
The Mac has 8 GiB RAM with substantial swap use, so compilation resumed with one
compiler job, the same soft 2 GiB Siso heap limit and the 3 GiB disk floor. This
reduces concurrent build pressure; it changes no browser runtime flag.

A point-in-time resume audit found 11,366 completed C++ output records and no
duplicate outputs across retained PGO attempts. This verifies preserved progress,
not a completion percentage. With recovered disk headroom, the runner previously used
two compiler jobs under the same soft 2 GiB Siso heap limit, GOGC 100, two Go
execution threads and 3 GiB free-space floor. Both compiler slots were observed
running while free space remained above 4.6 GiB. Compiler flags are unchanged.
The audit is `build/performance-20261029/pgo-resume-audit.json`; the read-only
Siso sample is `siso-balanced-memory-sample.txt` beside it.

## Verification and evidence

- Independent Standards and Spec reviews found two workflow/measurement gaps,
  both addressed: compiled-list builds now enforce an isolated tree and
  `--build-only`, and initialized v6 benchmarks require actual foreground proof.
  Focused follow-up reviews found no remaining defect in those fixes. The full
  two-axis report is `build/performance-20261029/final-source-review/review.md`.
- 26 focused host/bridge/store tests passed, none skipped.
- 52 settings/context/helper tests passed after the worker-retirement fix. The
  real packaged 40-second regression fails on r3 and passes on r4.
- The updater lifetime change passed 70 adjacent tests and the signed r4/r5
  transport comparison. Focused Standards and Spec reviews found no new defect;
  their reports are `final-source-review/updater-standards.md` and
  `final-source-review/updater-spec.md` in the evidence directory.
- Nine workspace browser/Peek/frame tests passed, none skipped. The new row test
  also passed by itself; its original implementation fails with 42 mutations.
- Nine build-profile checks passed; 25 current benchmark accounting checks passed.
- Real CLI discovery passed for both Codex and Claude without paid inference.
- The full source suite had 230 passes and one failure, none skipped. The failure
  is the concurrent new-tab work's geometry test, which expects eight tiles but
  sees nine after an Add shortcut tile was introduced. This candidate does not
  include those unrelated new-tab edits.
- Native candidate acceptance and the final paired comparison remain unfinished.
  Physical native pointer routing and Keychain authorization are not verified by
  the fixture tests. Native packaged filtering has passed the checks above.

Raw local evidence is under `build/performance-20261029/`. The completed baseline
is `build/performance-20261029-baseline-v4-r3/results.json`; preceding failed
attempts remain beside it. `candidate.json` records every baseline/candidate file
hash and the unsigned native hashes. `native-pgo-state.json` and
`native-pgo.log` record native build progress and its storage guard. Temporary
measurement profiles are disposable; the real browser profile is never used.
`native-blocker-pairs-r2.json` contains all 12 current native cold-filter trials
and memory samples. `native-r2-verification.json` records packaged-resource,
cache and saved-engine checks; `native-blocker-candidate-r2.json` records bundle
hashes. `filter-behavior-race-red.json` and `filter-behavior-race-green.json` retain
the failing and passing concurrent-update reproductions and differential behavior
checks. Earlier candidate evidence remains beside them. `gui-keychain-diagnosis.json`
and `gui-sample-63089.txt` retain the authorization-wait evidence. The failed GUI
run is `build/performance-20261030-candidate-v4-r1/`.
`native-blocker-warm.json` records compiled-cache precedence and the real
saved-engine restart. `script/verify_breezer_filter_lists_native.mjs` reruns those
checks and the packaged byte/fallback checks against a staged native build.
`native-helper-lifetime-cli.json` records the real helper process checks;
`native-shared-helper-lifetime.json` records the six-connection r3 checks and
`native-blocker-candidate-r3.json` records its bundle hashes.
`settings-native-lifetime-red.json` and `settings-native-lifetime-green.json`
record the actual production clients before and after worker retirement;
`native-blocker-candidate-r4.json` records the corrected candidate's bundle hashes.
`native-update-lifetime-r5.json` records the three-client native comparison and
its measured updater footprint. `native-blocker-candidate-r5.json` records the
current bundle, and `native-pgo-updater-r5.json` records the checkpoint migration.
`macos-memory-probe-verification.json` records allocation/release validation of
the kernel memory probe. These diagnostics ran during PGO compilation and are
functional checks, not timing or comparative CPU measurements.
`footprint-prepare-verification-r2.json` records v7 preparation and exact legacy
summary replay. `benchmark-footprint-native-r2.json` records the real process-exit
control; `native-browser-footprint-verification.json` records all eight native
browser processes across three captures. The original outer inventory failure is
`footprint-prepare-inventory-failure.json`. Preparation is unscored.
