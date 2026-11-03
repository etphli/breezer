# Installed browser benchmark

`script/benchmark_browsers.mjs` compares installed native macOS app bundles. It launches each executable directly with a temporary profile, connects through the Chrome DevTools Protocol, and preserves existing user browser processes and profiles. It needs Node 22 or later and Xcode command line tools. It has no npm dependencies.

Preparation does not launch either browser:

```sh
node script/benchmark_browsers.mjs --prepare \
  --breezer "$HOME/Applications/Breezer.app" \
  --chrome '/Applications/Google Chrome.app' \
  --output build/benchmark-20261027-prepared
```

After the candidate bundle is verified and builds and competing tests have stopped, run:

```sh
node script/benchmark_browsers.mjs --run \
  --breezer /path/to/candidate/Breezer.app \
  --chrome '/Applications/Google Chrome.app' \
  --output build/benchmark-20261027-run \
  --trials 6 --repetitions 3 --tabs 10 --settle-seconds 5 --memory-samples 5
```

The output directory must be new and its parent must exist. Store temporary evidence under the ignored `build/` directory. Keep the machine plugged in, with stable power and display settings, and avoid other active work during the run. Existing open browser sessions contribute system load, but their memory is excluded from each measured process tree.

## Initialized-profile comparison

The current protocol is v9. Every app receives `--use-mock-keychain` with its
temporary profile. An initial 1.2.1 attempt stopped before scoring when a macOS
credential prompt blocked navigation. A diagnostic reproduced the failure and
confirmed that the test keychain permits ordinary setup and foreground readiness.
The failed attempt remains separate. This mode does not measure real Keychain
access, credential-store behavior or authenticated profiles. It changes no
installed app, stored password or browser feature setting.

All participants must be rerun with the same v9 flags. Historical v8 measurements
cannot be pooled with them. Fresh-profile runs also carry a v9 label.

V9 retains the v6 foreground endpoints,
v7 footprint accounting, workload, flags and balanced orders described below.
During untimed setup it also handles the new Breezer setup guide: it invokes the
shipped **Skip setup** button, waits for the guide's own completed state, and
closes only that exact guide tab after it becomes the known product new tab.
It never writes fabricated setup/seen values or closes unexpected pages. Older
bundles still use their actual first-run notes. Setup actions are recorded in
each setup observation; extension inspection sessions are detached afterward.

The full labels are `installed-browser-v9-initialized-foreground`,
`installed-browser-v9-initialized-three-way`, and their `-footprint` variants.
All comparison participants must be rerun under v9. Earlier v6/v7/v8 reports remain
labelled history. The first v7 attempt against the new guide failed before any
scored launches and is preserved separately from the v8 run.

For current Breezer editions that open a one-time update page, add
`--initialized-profiles` to the run command. This selects protocol
`installed-browser-v6-initialized-foreground`. It leaves onboarding enabled and
performs an untimed setup launch for **both** products with the same fixture and
flags. For Breezer it waits for the bundled extension to record its seen edition,
closes only the exact bundled `whats-new.html` page, and waits until the fixture
is the sole content tab. It neither suppresses nor changes the shipped release
page behavior. Unknown tabs cause setup to wait or fail rather than being closed.
The setup observations are retained in `setups`, outside the timing summaries.

Each setup and measured launch asks AppKit to activate only the launched PID and
its windows. The native probe retries until the activation request is accepted,
then waits for that PID to be active and frontmost with a sufficiently large
on-screen window. It advances the main run loop so AppKit's time-varying state
can refresh. After the document and native-window gates pass, a second native
snapshot must confirm the same conditions. That proof is retained as
`startupNativeForeground`; the startup interval ends after this check.

Activation and verification are inside the startup interval and apply equally to
every app. This is protocol v6: v4/v5 requested activation but did not verify
foreground state at the endpoint. Retain their old results as labelled history;
rerun every comparison participant under v6. Double animation frames, flags,
fixture, memory sampling, alternating order and failure retention are unchanged.

The first measured launch is `profileState: initialized`; its summary is
`startupInitializedProfileMs`. It follows setup and is **not** fresh-profile
startup. The second measured launch is `reused`. Do not compare initialized
startup directly with older fresh-profile results as an optimization claim.
Rerun the baseline and candidate with this same protocol and options. Setup
failures remain failures and their partial observations are not pooled into a
completed run.

## Candidate, baseline and Chrome in one run

Add `--baseline-breezer` to compare the candidate, a previous Breezer bundle and
Chrome in the same session. This selects
`installed-browser-v6-initialized-three-way`, requires `--initialized-profiles`
and a multiple of six rounds. In each six-round block, all six app orders occur
once. Every app occupies each position twice, and each pair appears in either
order three times. The exact schedule is recorded in `roundOrders`.

```sh
node script/benchmark_browsers.mjs --run --initialized-profiles \
  --breezer /path/to/candidate/Breezer.app \
  --baseline-breezer "$HOME/Applications/Breezer.app" \
  --chrome '/Applications/Google Chrome.app' \
  --output build/benchmark-three-way-run \
  --trials 6 --repetitions 3 --tabs 10 --settle-seconds 5 --memory-samples 5
```

Use `--prepare` with the same arguments and a different new output directory to
verify all three bundles and compile the window probe without launching them.
The two Breezer inputs must have Breezer's bundle identity; Chrome must have
Chrome's identity. Duplicate executable hashes are rejected. The installed
baseline is only read and launched with a disposable profile; no app installation
or replacement is required.

Every app receives the same untimed setup, initialized/reused launches, fixture,
flags, verified foreground readiness, memory sampling and failure handling.
Six rounds produce 36 scored launches plus 18 untimed setup launches. The
previous Breezer's summary is `baselineBreezer`; candidate and Chrome retain
`breezer` and `chrome`. Failed setup or measurements leave the run failed. The
ordinary two-app command retains its alternating order. Its initialized mode now
uses v6 foreground verification; fresh-profile v3 endpoints remain unchanged.

## macOS footprint comparison

Add `--physical-footprint` to an initialized-profile command to collect macOS
footprint alongside RSS. This selects `installed-browser-v7-initialized-foreground-footprint`
or `installed-browser-v7-initialized-three-way-footprint`. Preparation compiles
the read-only `script/macos_process_usage.c` probe and records its source and
executable hashes. Run every participant with the same mode and options.

```sh
node script/benchmark_browsers.mjs --run --initialized-profiles --physical-footprint \
  --breezer /path/to/candidate/Breezer.app \
  --baseline-breezer "$HOME/Applications/Breezer.app" \
  --chrome '/Applications/Google Chrome.app' \
  --output build/benchmark-three-way-footprint-run \
  --trials 6 --repetitions 3 --tabs 10 --settle-seconds 5 --memory-samples 5
```

The probe reads `ri_phys_footprint` through `proc_pid_rusage`, using the fixed
`RUSAGE_INFO_V4` layout. Footprint accounts for dirty memory and charges compressed
or swapped pages; it is not a count of currently resident or uniquely owned RAM.
See [Apple's memory accounting explanation](https://developer.apple.com/videos/play/wwdc2022/10106/).

For each RSS sample, the tool retains that process listing, reads native usage,
lists the owned tree again, then reads native usage again. It requires the same
complete PID set, parent, command, role and process start time in both listings.
Processes must predate capture by more than one second because `ps lstart` has
one-second resolution. Both native reads must also agree on kernel start identity
and executable UUID. Missing processes/counters, exits, identity changes and
invalid capture bounds make the footprint sample unavailable, without a number.
Partial captures never become smaller memory scores.

The sample sums the first native read's footprint values. Both raw native reads
and process listings remain in the report. These are sequential observations;
short-lived children between listings and simultaneous memory peaks are not
covered. Per-process lifetime maxima are retained as diagnostic data and are not
summed. Every sample must be observed for the trial's footprint median, and every
trial median must be observed for an app's summary. Unavailable data remains
unavailable rather than being dropped or replaced with zero. The summary fields
are `oneTabPhysicalFootprintMiB` and `multiTabPhysicalFootprintMiB`.

V7 keeps v6 startup, foreground, tab/navigation endpoints, flags and balanced
order. Its additional native reads and process listing run after each RSS/CPU
listing's capture timestamp. They add time between samples, so CPU uses the
actual recorded elapsed interval. The extra instrumentation is why v7 has a
separate protocol label. Existing v3/v6 commands retain their sampling path.
Historical RSS cannot be converted into footprint. Rerun the candidate, baseline
and Chrome together for new comparisons.

## What it measures

Each of six rounds alternates which browser goes first. For each browser, the tool creates a new temporary profile, measures its first launch, exercises tabs and navigation, measures memory, quits that browser instance, and measures a relaunch of the same profile. After the memory check it closes only the extra fixture tabs it created, explicitly activates the retained tab, and returns that tab to the common fixture URL before quitting. Explicit activation requests the retained foreground tab before the post-measurement animation-frame readiness check. It does not establish the cause of an animation-frame timeout; a timed-out run remains failed. It records content-tab inventories at startup, at ten tabs, and before quitting, and requires a single content tab on both launches. An unexpected restored session fails the run. It removes the temporary profile after the pair. These are **fresh-profile** and **reused-profile** launches. Neither is an OS-cold launch: the tool does not reboot, flush file caches, or claim to control the OS page cache. Six rounds give each browser three first positions. Use an even number of rounds to keep positions balanced.

All timing values use the same host monotonic clock. Startup begins immediately before spawning the executable. For fresh-profile v3, it ends at the later of a visible native window and a loaded fixture document after two animation frames. The native probe checks CoreGraphics for an on-screen, layer-zero window owned by the launched PID, at least 320 by 200 pixels. The page check requires a complete document, the expected URL, a body with positive width, and two animation frames. Initialized v6 also requires the final foreground snapshot described above and ends after that verification. This estimates a visible usable page. It does not prove that every native toolbar control has finished drawing, or measure keyboard input response. Polling, CDP connection and native verification overhead are included and apply equally to every app.

New-tab timing starts before `Target.createTarget` and ends after the new foreground document is ready and two animation frames have passed. It separately measures `about:blank` and each browser's `chrome://newtab/` document. It waits for the product new tab to leave `about:blank`, and records the actual resolved URL. This measures programmatic tab creation and document readiness. It excludes a user's click or shortcut and does not establish that every asynchronous native new-tab control is ready.

Local navigation timing starts before `Page.navigate` and uses the same document readiness endpoint. It also records the full `PerformanceNavigationTiming` entry, including `domContentLoadedEventEnd`, `loadEventEnd`, and response timings. These page clock values are separate from host elapsed time. Both browsers receive exactly the same deterministic HTML, CSS, inline SVG, and script from one localhost server. Responses use `Cache-Control: no-store`; there are no external page resources. The HTML SHA-256 appears in the result.

Memory is the sum of resident set sizes reported by macOS `ps` for the launched browser and every descendant. It is sampled five times, one second apart, after five seconds settling with one fixture tab and again with ten fixture tabs. Component extensions and native browser features remain enabled. Breezer's native workspace sidebar appears as a CDP `page` target, but it is excluded from content-tab counts only when the exact component URL is also verified by `chrome.runtime.getContexts` as `SIDE_PANEL` with `tabId: -1` and is absent from `chrome.tabs.query`. Its renderer and all other component memory remain included in RSS. Unverified or actual extension tabs still count. RSS can count shared pages more than once across processes, so this is **process-tree RSS**, not unique physical footprint or Activity Monitor's Memory value. Each sample includes the exact owned PIDs, sizes, and executable names. Per-trial medians feed the overall memory summary.

Each process sample also records its Chromium `--type` role, `ps` CPU percentage, cumulative CPU time, and process start time. CPU percentage is the operating system's estimate over a varying prior interval, not utilization over the one-second sampling interval. It is retained as diagnostic evidence and never enters the window CPU calculation. Renderer PIDs remain separate in the evidence. A renderer PID is not assumed to identify a particular tab or extension, and renderer RSS can include shared pages.

### Observed CPU during settled memory sampling

`memoryOneTab.cpu` and `memoryMultiTab.cpu` analyse the same five RSS samples after the same five-second settle. The CPU calculation adds no browser requests, process listings, or sample delays. CPU observation starts with the first listing and ends with the fifth, covering roughly four seconds plus listing overhead in v3/v6. V7 also includes the intervening footprint-probe time, as described above. It excludes the settle, startup, tab creation, navigation and readiness periods.

macOS `ps time` supplies cumulative user + system CPU time without adding exited children's CPU time. The parser accepts the locally observed `minutes:seconds.hundredths` format, including minute counts above 59. For each process present in every sample, the calculation subtracts its first counter from its last and checks all intermediate counters for decreases. It sums those deltas as `observedCpuSeconds` only when the result exceeds aggregate counter uncertainty. `counterResolutionSeconds` is 0.01. `counterUncertaintyCpuSeconds` allows 0.02 seconds per process for the two displayed endpoints. `counterUncertaintyCpuSecondsPerElapsedSecond` divides that allowance by the observation duration. These fields describe counter precision only; missing process work has no bounded uncertainty.

For a conservative lower bound, the calculation subtracts up to 0.02 seconds from each process delta, allowing one displayed centisecond of error at each endpoint, and floors each result at zero. Their sum is `cpuSecondsLowerBound`. `elapsedSeconds` runs from the host monotonic timestamp before the first `ps` call to the timestamp after the last call. These outer bounds include listing overhead and avoid assuming simultaneous process snapshots. `cpuSecondsPerElapsedSecondLowerBound` divides the lower-bound CPU seconds by this elapsed time. A value of 1 means at least one aggregate CPU second per elapsed second, equivalent to 100% of one core. It is not normalized by the machine's core count, and it can exceed 1.

The result has status `observed-lower-bound`, plus sample and process counts and an explicit coverage limitation. It covers only the process tree visible in the sampled listings. A child that starts and exits between listings contributes nothing, even when every observed PID stays stable. Processes that leave the owned tree can also escape observation. There is no complete process-lifecycle accounting. The metric does not measure energy or battery life and does not support a full-browser CPU claim, a ratio of browser efficiencies, or a 10x improvement claim. Per-window values remain in the raw trials; the summary does not pool them or silently discard unavailable windows.

CPU is `unavailable`, with a reason and no CPU seconds or rate result, if the total observed delta is at or below aggregate counter uncertainty, the sampled tree changes, a PID's start time, parent, executable or role changes, a counter is missing, unsupported or decreases, or capture timestamps are missing, overlap or fail to increase. Near-zero windows retain their resolution, uncertainty, duration and counts, and raw counters remain in the samples. For example, 50 PIDs give a one-second aggregate counter allowance, which can overwhelm idle CPU work in a roughly four-second window. No ratio is computed, even for observations above that allowance. The browser root must appear in every listing. `lstart` is captured in the C locale and normalized to an ISO timestamp. Because it has only one-second resolution, a process must have started more than one second before the first capture wall time; otherwise its identity is rejected. Wall time is used only for this identity guard and assumes the system clock is correct; elapsed CPU rates use the monotonic clock. Legacy reports without these timestamps and identities cannot yield this metric. There is no retry, replacement sample or change to the RSS result when CPU accounting is unavailable.

## Diagnosing failed or slow observations

Results using this instrumentation carry protocol label `installed-browser-v3-observed-cpu`. Relative to `installed-browser-v2-diagnostics`, memory samples add monotonic capture bounds, capture wall time and the `lstart` column to the same `ps` listing, then derive the limited CPU observation above. The fixture, common flags, launch order, startup, new-tab and navigation endpoints, document checks, two-animation-frame endpoint, five-second settle, five RSS samples and 30-second CDP request timeout are unchanged. Both browsers use identical accounting. The earlier diagnostics revision added document and animation-frame timestamps, navigation acknowledgements, CPU columns and failure snapshots. Disclose instrumentation differences when comparing with older reports. Run both products with the same harness revision and options; keep the original reports.

Every caught launch or exercise failure writes `<launch-label>.failure.json` before closing the isolated browser. It includes the failed operation and readiness stage, expected URL, actual URL, document visibility and focus, document readiness, viewport, navigation timing, CDP target inventory, target window bounds/state, native owned-window bounds and on-screen flags, application active/hidden state, and owned process RSS/CPU. The native snapshot omits window titles. Individual unavailable probes record their errors instead of suppressing the original failure. Diagnostic CDP requests have a separate 1.5-second limit; native and process commands have two-second limits. These probes run only after failure and do not activate the app, change tabs, navigate, retry a sample, or turn a timeout into success. A launch that fails before returning an instance is retained in `results.json` as `failedLaunch`.

The public `captureFailureState(instance, error)` helper supports disposable-profile diagnostics. It expects a CDP connection, an `operation` with target/session identifiers, and `nativeWindowSnapshot` and `captureLoad` callbacks. `pageReady` exposes the same readiness checks for those diagnostics and annotates failures with the readiness stage. Use a documented untimed diagnostic separately from scored runs, and label any extra tracing flags or controlled background-tab checks.

For a slow navigation, retain the observation and compare host elapsed time with the full navigation entry. A large delay before `requestStart` needs network/request evidence; it does not establish a rendering or animation-frame cause. A hidden-tab negative control can verify that frame waits fail truthfully, but it does not prove why an intermittent foreground sample timed out. Capture failure state in the actual failing run before drawing that conclusion.

For the next comparison, prepare a new directory, verify the candidate bundle and wait for an idle build queue, then run the chosen six-round command with identical settings for every app. Preserve every failed attempt, all slow observations, fixture and executable hashes, and the complete raw report. A failed attempt remains failed even if completed pairs are described separately. Any later activation, timeout, server, tracing, or endpoint change starts a labelled protocol revision and requires every product to be rerun identically.

## Flags and evidence

Both apps receive exactly these flags, followed by the same fixture URL:

```text
--user-data-dir=<new isolated directory>
--no-first-run
--no-default-browser-check
--remote-debugging-port=0
--window-size=1280,900
```

The profile path differs by instance. `--no-first-run` removes onboarding from both measurements. No flags disable extensions, component extensions, GPU, sandboxing, network activity, background browser work, or Breezer features. There are no Playwright default flags. Browser background services may still use the network, so their behavior remains part of the installed product and a source of variability.

`results.json` records every trial, summaries, exact executable command lines, executable SHA-256, app and engine versions, CPU, RAM, macOS, power and thermal state, system load, VM statistics, repository revision and status. It records environment snapshots before the run, after each timed startup, and after completion. Browser stdout and stderr are stored per launch. Summaries report median, minimum, maximum, and quartiles. Repeated tab and navigation observations from one browser instance are correlated; use the launch-level observations when evaluating repeatability. This small local benchmark does not establish general browsing speed or battery life.

Cleanup sends `Browser.close` only through the isolated instance's debugging connection. Any remaining processes are signaled only if their PID and full command still match a previously observed member of that owned process tree. It never uses global `killall`, broad `pkill`, or a user's default profile.

Verify the tool's process accounting and summary calculations without opening any browsers:

```sh
node --test tests/benchmark-browsers.test.mjs
node --check script/benchmark_browsers.mjs
```

Protocol and timing definitions are documented by the [Chrome DevTools Protocol Target domain](https://chromedevtools.github.io/devtools-protocol/tot/Target/) and [W3C Navigation Timing](https://www.w3.org/TR/navigation-timing-2/).
