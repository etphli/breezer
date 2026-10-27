# Installed browser benchmark

`script/benchmark_browsers.mjs` compares installed native macOS app bundles. It launches each executable directly with a temporary profile, connects through the Chrome DevTools Protocol, and preserves existing user browser processes and profiles. It needs Node 22 or later and Xcode command line tools. It has no npm dependencies.

Preparation does not launch either browser:

```sh
node script/benchmark_browsers.mjs --prepare \
  --breezer "$HOME/Applications/Breezer.app" \
  --chrome '/Applications/Google Chrome.app' \
  --output build/benchmark-20261027-prepared
```

After the final app has been installed and builds and competing tests have stopped, run:

```sh
node script/benchmark_browsers.mjs --run \
  --breezer "$HOME/Applications/Breezer.app" \
  --chrome '/Applications/Google Chrome.app' \
  --output build/benchmark-20261027-run \
  --trials 6 --repetitions 3 --tabs 10 --settle-seconds 5 --memory-samples 5
```

The output directory must be new and its parent must exist. Store temporary evidence under the ignored `build/` directory. Keep the machine plugged in, with stable power and display settings, and avoid other active work during the run. Existing open browser sessions contribute system load, but their memory is excluded from each measured process tree.

## What it measures

Each of six rounds alternates which browser goes first. For each browser, the tool creates a new temporary profile, measures its first launch, exercises tabs and navigation, measures memory, quits that browser instance, and measures a relaunch of the same profile. After the memory check it closes only the extra fixture tabs it created, explicitly activates the retained tab, and returns that tab to the common fixture URL before quitting. Explicit activation requests the retained foreground tab before the post-measurement animation-frame readiness check. It does not establish the cause of an animation-frame timeout; a timed-out run remains failed. It records content-tab inventories at startup, at ten tabs, and before quitting, and requires a single content tab on both launches. An unexpected restored session fails the run. It removes the temporary profile after the pair. These are **fresh-profile** and **reused-profile** launches. Neither is an OS-cold launch: the tool does not reboot, flush file caches, or claim to control the OS page cache. Six rounds give each browser three first positions. Use an even number of rounds to keep positions balanced.

All timing values use the same host monotonic clock. Startup begins immediately before spawning the installed executable. Its endpoint is the later of a visible native window and a loaded fixture document after two animation frames. The native probe checks CoreGraphics for an on-screen, layer-zero window owned by the launched PID, at least 320 by 200 pixels. The page check requires a complete document, the expected URL, a body with positive width, and two animation frames. This estimates a visible usable page. It does not prove that every native toolbar control has finished drawing, or measure keyboard input response. Polling and CDP connection overhead are included and apply to both browsers.

New-tab timing starts before `Target.createTarget` and ends after the new foreground document is ready and two animation frames have passed. It separately measures `about:blank` and each browser's `chrome://newtab/` document. It waits for the product new tab to leave `about:blank`, and records the actual resolved URL. This measures programmatic tab creation and document readiness. It excludes a user's click or shortcut and does not establish that every asynchronous native new-tab control is ready.

Local navigation timing starts before `Page.navigate` and uses the same document readiness endpoint. It also records the full `PerformanceNavigationTiming` entry, including `domContentLoadedEventEnd`, `loadEventEnd`, and response timings. These page clock values are separate from host elapsed time. Both browsers receive exactly the same deterministic HTML, CSS, inline SVG, and script from one localhost server. Responses use `Cache-Control: no-store`; there are no external page resources. The HTML SHA-256 appears in the result.

Memory is the sum of resident set sizes reported by macOS `ps` for the launched browser and every descendant. It is sampled five times, one second apart, after five seconds settling with one fixture tab and again with ten fixture tabs. Component extensions and native browser features remain enabled. Breezer's native workspace sidebar appears as a CDP `page` target, but it is excluded from content-tab counts only when the exact component URL is also verified by `chrome.runtime.getContexts` as `SIDE_PANEL` with `tabId: -1` and is absent from `chrome.tabs.query`. Its renderer and all other component memory remain included in RSS. Unverified or actual extension tabs still count. RSS can count shared pages more than once across processes, so this is **process-tree RSS**, not unique physical footprint or Activity Monitor's Memory value. Each sample includes the exact owned PIDs, sizes, and executable names. Per-trial medians feed the overall memory summary.

Each process sample also records its Chromium `--type` role, `ps` CPU percentage, and cumulative CPU time. CPU percentage is the operating system's process estimate, not utilization over the one-second sampling interval. Renderer PIDs remain separate in the evidence. A renderer PID is not assumed to identify a particular tab or extension, and renderer RSS can include shared pages.

## Diagnosing failed or slow observations

Results using this instrumentation carry protocol label `installed-browser-v2-diagnostics`. The fixture, flags, launch order, document checks, two-animation-frame endpoint, and 30-second CDP request timeout are unchanged. Added host timestamps split document readiness from animation-frame wait and record the `Page.navigate` acknowledgement. Memory samples request extra CPU columns from the same `ps` process listing. The native window helper also links AppKit to support failure snapshots. These instrumentation differences must be disclosed when comparing with older reports. Run both products with the same harness revision and options; keep the original reports.

Every caught launch or exercise failure writes `<launch-label>.failure.json` before closing the isolated browser. It includes the failed operation and readiness stage, expected URL, actual URL, document visibility and focus, document readiness, viewport, navigation timing, CDP target inventory, target window bounds/state, native owned-window bounds and on-screen flags, application active/hidden state, and owned process RSS/CPU. The native snapshot omits window titles. Individual unavailable probes record their errors instead of suppressing the original failure. Diagnostic CDP requests have a separate 1.5-second limit; native and process commands have two-second limits. These probes run only after failure and do not activate the app, change tabs, navigate, retry a sample, or turn a timeout into success. A launch that fails before returning an instance is retained in `results.json` as `failedLaunch`.

The public `captureFailureState(instance, error)` helper supports disposable-profile diagnostics. It expects a CDP connection, an `operation` with target/session identifiers, and `nativeWindowSnapshot` and `captureLoad` callbacks. `pageReady` exposes the same readiness checks for those diagnostics and annotates failures with the readiness stage. Use a documented untimed diagnostic separately from scored runs, and label any extra tracing flags or controlled background-tab checks.

For a slow navigation, retain the observation and compare host elapsed time with the full navigation entry. A large delay before `requestStart` needs network/request evidence; it does not establish a rendering or animation-frame cause. A hidden-tab negative control can verify that frame waits fail truthfully, but it does not prove why an intermittent foreground sample timed out. Capture failure state in the actual failing run before drawing that conclusion.

For the next comparison, prepare a new directory, wait for the final installed app and an idle build queue, then run the six-round command above unchanged for both products. Preserve every failed attempt, all slow observations, fixture and executable hashes, and the complete raw report. A failed attempt remains failed even if completed pairs are described separately. Any later activation, timeout, server, tracing, or endpoint change starts a labelled protocol revision and requires both products to be rerun identically.

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
