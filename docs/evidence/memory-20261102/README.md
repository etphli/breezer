# Memory work and unattended PC build

This records four verified units of the RAM reduction work. The installed app,
profiles and compiled caches are unchanged. Nothing has been scheduled or started
on the PC. Ethan will give the start instruction tomorrow. The PC will remain unreachable
until he says it is available; do not probe it in the meantime.

## Scope and acceptance

Keep a memory change only after reproducing the retention before the change,
checking collection afterward, and exercising the affected page-control paths.
For the build, independent work must continue after an action failure, completed
outputs must survive a resume, checkpoints must land at 10,000 observed finished
actions, recovery must be bounded, and a manual stop must not restart the worker.
A failed action must prevent a successful result.

Whole-browser RAM, CPU, navigation, feature acceptance and the PC runtime are
separate gates. These remain open until a new native build is available.

## Detached page content

The page-control snapshot stored up to 180 DOM elements in a strong Map. If a
page removed those elements, their subtrees remained reachable until another
snapshot or document navigation. The map now holds weak references. Every lookup
dereferences the target and retains the existing visibility, identity, focus,
secret-field and stale-target checks. Connected elements remain owned by the DOM.

The disposable Chromium 156.0.8078.4 check creates 180 links with 200 child spans
each, captures a production snapshot in an isolated world, removes those links, forces garbage
collection and reads actual browser DOM counters. The baseline retained 72,180
extra nodes. The candidate retained zero. Both refused the removed targets;
the candidate also resolved a still-connected target after collection.

This is a synthetic retention check. It does not measure unique physical RAM,
whole-browser RAM, general navigation or ordinary tabs that never used AI page
control. Do not attribute a general browser RAM improvement to this result.

Reproduce from the repository root with Playwright installed in `tests/ai`, or
set `BREEZER_PLAYWRIGHT_MODULE` to an existing Playwright entry point:

```sh
git show 1ddab549:features/ai/extension/page-context.js > /tmp/breezer-page-context-before.js
node script/verify_page_context_memory.mjs --source /tmp/breezer-page-context-before.js
node script/verify_page_context_memory.mjs --expect-released
node --test tests/ai/browser-tools.test.mjs tests/ai/docs-editor.test.mjs
node tests/ai/browser-page.mjs
node tests/ai/docs-editor-browser.mjs
```

The browser fixtures use disposable profiles and synthetic pages. The Docs
fixture does not establish authenticated Google Docs or native app acceptance.
The source checks passed 44/44. Both real browser interaction fixtures passed.
Raw retention reports are adjacent; full working logs and screenshots are under
`build/efficiency-20261102` in this checkout.

## Translation restoration records

A second real-DOM check found that translation's original-text Map retained a
removed page section after the translation UI disconnected. The section contained
10,000 spans. The old script retained 20,002 extra DOM nodes after forced GC;
Restore released them. With weak text records and weak node references, the
removed section is collected while the original text of still-connected nodes
remains available for Restore. Text edited by the site is preserved.

The check runs the shipped content script in an isolated world in disposable
Chromium with a fixture translation port, sends one batch, disconnects, removes the section, and samples
actual DOM counters. It does not contact a translation provider. It also forces GC while translated nodes remain connected, then
reconnects and checks Restore against both an untouched and a site-edited node.
This is a targeted retention result, not a measurement of whole-browser RAM or
of tabs that never used translation.

```sh
git show 1ddab549:features/ai/extension/translation-content.js > /tmp/breezer-translation-before.js
node script/verify_translation_memory.mjs --source /tmp/breezer-translation-before.js
node script/verify_translation_memory.mjs --expect-released
node --test tests/ai/translation.test.mjs tests/ai/translation-browser.test.mjs
```

Seven translation source checks and the full disposable extension acceptance
check passed. The latter covers real worker/port transport, DOM identity,
restore, dynamic text, long-node batching, cancellation/retry, navigation,
permissions and unsupported documents. Its live LibreTranslate model acceptance
case remains skipped because no provider server is running. No provider API,
consent requirement, host permission or text-sharing behavior changed.

## Unused sidebar route markup

The sidebar used the same HTML document as Settings and welcome. It retained
both hidden routes for the lifetime of each browser window. Sidebar boot now
removes those two unused roots after the Settings and welcome route guards have
returned. Changing between these routes already reloads the full document, so
each route still starts with its complete markup.

Three balanced before/after pairs in disposable Chromium each removed 519 unused
HTML elements and 1,182 DOM nodes after forced GC. The sidebar fixture still
rendered every folder child exactly as before. The isolated pairs did not show
slower folder opening. These few observations do not establish a browser speed,
CPU-efficiency, native footprint or whole-browser RAM improvement. Full native
measurement remains required. Raw pairs are `sidebar-prune-paired.json`.

All nine real workspace browser cases passed, including Settings and welcome
navigation after pruning, shortcut activation with closed folders, drag/drop,
renaming, tab-event ordering, focus, restart and cross-window saved slots. The
two static checks passed. The existing browser fixture moved to
`tests/ai/workspace-browser-fixture.mjs` so the memory check and acceptance tests
use the same API behavior.

```sh
git show 1ddab549:features/ai/extension/workspace.js > /tmp/breezer-workspace-before.js
node script/verify_sidebar_memory.mjs --source /tmp/breezer-workspace-before.js
node script/verify_sidebar_memory.mjs --expect-pruned-routes
node --test tests/ai/workspace-static.test.mjs tests/ai/workspace-browser.test.mjs
```

An earlier experiment created folder child rows only when the folder opened.
It reduced hidden DOM and avoided unused favicon reads, but slowed opening the
folder in three balanced pairs at both 100 and 1,000 saved entries. It was
reverted. The rejected patch and `sidebar-paired.json` retain that evidence; the
accepted source does not defer or remove folder child rows.

The first pruning timing run overlapped the workspace acceptance suite and was
excluded. The pairs in `sidebar-prune-paired.json` were rerun after that suite
exited. The favicon fixture serves 32-pixel PNGs, matching the requested favicon
size, rather than adding artificial SVG document overhead per icon. These are
local fixture responses, with no requests to saved sites.

## Native message assembly

The native helper concatenated the entire partial message on every input chunk.
An 8 MiB JSON message split into 32 KiB chunks copied 1,086,324,768 bytes while
assembling one frame. Its empty remainder also kept the completed backing
buffer reachable. The decoder now owns one bounded body buffer, copies each
incoming byte once, and releases the buffer after parsing. The same direct
check copies 8,388,640 bytes and retains 16 extra ArrayBuffer bytes after forced
GC, compared with 8,388,656 before. These are decoder assembly and retention
counts, not the helper's full physical memory.
The body allocation starts with its first byte and is capped at the existing
16 MiB limit; a header-only fragment does not allocate it.

The actual `main.mjs` helper was then launched in six alternating before/after
pairs for each 4 KiB, 64 KiB, 1 MiB, 4 MiB and 8 MiB request size. Each trial sends synthetic invalid
Organato settings, which validation rejects before any provider, Keychain,
configuration write or network access. All other ten host modules are byte
identical. Trials use the packaged Node v24.22.1 binary, whose SHA-256 and each
source hash are recorded in the raw reports. A small read-only macOS probe
samples each owned helper process after forced GC.

Median physical footprint at 1, 4 and 8 MiB respectively was 28.80, 160.29 and
453.45 MiB before, and 20.30, 29.04 and 41.18 MiB afterward. Median helper CPU
was 11.70, 36.41 and 94.82 ms before, and 10.72, 13.49 and 18.08 ms afterward.
CPU includes transport, validation and the post-request forced collections.
Physical footprint uses macOS dirty, compressed and swapped accounting, rather
than unique browser RAM. These controlled large-message results do not predict
ordinary browsing savings or real AI latency. Raw ranges and every trial are in
`native-transport-final-*.json`; `native-transport-summary.json` holds medians.
The 4 KiB and 64 KiB results have overlapping ranges. No small-message memory
or CPU improvement is claimed. In particular, the 64 KiB CPU medians are
9.05 ms before and 9.15 ms afterward, with ranges of 8.74 to 13.83 and 8.86 to 9.51 ms.
The CPU samples include two forced collections, so this small difference does
not establish a decode-time regression or improvement.

The diagnostic wrapper uses IPC for sampling and explicitly terminates its owned
helper afterward. Its teardown is not evidence of normal production EOF exit;
the separate host-loading tests cover that path. Fixtures run in disposable
directories and do not change the installed app or its profile.

```sh
git show 1ddab549:features/ai/host/protocol.mjs > /tmp/breezer-protocol-before.mjs
node --expose-gc script/verify_native_decoder_memory.mjs --source /tmp/breezer-protocol-before.mjs
node --expose-gc script/verify_native_decoder_memory.mjs --expect-bounded
node script/benchmark_native_transport.mjs --baseline-protocol /tmp/breezer-protocol-before.mjs --bytes 8388608 --rounds 6 --usage-probe build/efficiency-20261102/usage-probe --output build/efficiency-20261102/native-transport-recheck.json
node --test tests/ai/host.test.mjs tests/ai/host-loading.test.mjs tests/ai/native-frame-memory.test.mjs
```

For matching evidence, use the packaged Node v24.22.1 executable rather than an
unrelated system Node. The probe can be compiled independently of Breezer with
`xcrun clang -O2 -Wall -Wextra -Werror script/macos_process_usage.c -o build/efficiency-20261102/usage-probe`.
The 35 host checks pass on the packaged runtime. They exercise every split
boundary, byte-array input, reused input buffers, seeded fragmentation,
coalesced frames, exact size limits, fatal UTF-8 and invalid/truncated frames.
Origin, consent, tool validation and provider loading checks also pass.
`script/summarize_native_transport.py` recomputes every reported median and
range from the raw trial files and rejects mixed runtime or source identities.

GPT-6 Luna found no decoder correctness issue. The review flagged a missing
automatic packaging gate. `--memory-packet` now checks the bundled decoder
against the packet receipt, with five focused passing tests covering a match,
stale bytes, corruption, symlink escape and enforcement by the package command.
The five existing runtime packaging checks also pass. The packet keeps this
post-compilation helper receipt separate from its three Chromium resources.
See the [packaging handoff](../../pc-build.md#package-the-tested-native-decoder-after-compilation).

## Unattended build

`script/windows/unattended_build.py` supervises the existing prepared worker.
The worker still owns pinned input validation, its memory guard, 4/2/1 job
backoff, `ninja -k0`, and expected-output validation. The supervisor adds:

- An exclusive output lock for other supervisor instances.
- Durable progress state every five seconds while output is consumed.
- Filesystem flushing and atomic checkpoint records every 10,000 observed
  finished actions, and at success or a controlled stop.
- At most three automatic retries with five minutes between attempts, for
  confirmed paging-guard pauses or a killed worker, never a reported failed
  compile action. The original worker still rechecks inputs on every attempt.
- Explicit completed, failed, cooldown and stopped results, recent error lines,
  worker/build hashes, output-preservation status and a resume command.

Finished-action counts include failures. They are not successful-action counts
or a release percentage. They accumulate observed actions across worker passes;
a resumed graph can have a smaller remaining total. Ninja saves finished work
incrementally, so recovery does not wait for the next 10,000-action checkpoint.
Checkpoints flush the existing output tree; they do not duplicate it or promise
recovery from drive loss. A hard compiler error still fails the full build after
independent work finishes. The runner does not invent source repairs.

Twenty-two local tests passed. One additional Linux orphan-adoption test is skipped
on this Mac and must pass on the PC before deployment. These include a real failing Ninja graph whose
independent actions finish and whose completed outputs retain their mtimes on
resume; 10,001 real Ninja file-producing actions with the default 10,000 boundary; bounded
recovery; manual stop including a detached driver before its state is published;
forced cleanup of a driver ignoring interrupt and termination; locking; stale state; compiler errors after a paging
backoff; and idempotent, hash-checked three-resource source/pin migration with unchanged objects. The migration validates
all resources before any write and preserves their mtimes on a repeated run. A logged failed action also
prevents success even if the worker exits zero.

```sh
python3 -m unittest discover -s tests/windows -p '*_test.py' -v
```

On Linux the supervisor adopts orphaned descendants, including a driver started
just before a worker crash. Shutdown freezes the worker while discovering its
children, then terminates the owned process groups with bounded escalation.
The Linux adoption path remains unverified here.

The PC SSH preflight timed out during banner exchange. The Windows preparation
and launcher scripts have not run there. No PowerShell interpreter is available
on this Mac, so those scripts have only been inspected. Full PC execution,
candidate packaging, whole-browser memory measurements and broad regression
checks remain open. The single-helper measurements above do not close those gates.

See [the PC runbook](../../pc-build.md#prepare-the-unattended-memory-build) for
packet staging and tomorrow's deliberate start. The source change was written
by GPT-6.1 Sol. The decision trail is [decisions.tsv](decisions.tsv).

GPT-6 Luna reviews found a shutdown race, incomplete cleanup after a
timeout, a freeze-timeout cleanup gap, and a missing success gate for logged failures. The new regression
checks reproduce those contracts and pass on the Mac; Linux crash adoption and
PC launch remain separate gates.

A GPT-6 Luna review of the translation fix and two-resource migration found no
actionable issue. Both targeted verifiers now run production code in isolated
worlds. The translation check confirms that connected-node Restore survives
forced GC; the page-control check confirms connected targets still resolve.

GPT-6 Luna reviewed the sidebar-only pruning and three-resource migration with
no actionable findings. Per-run source hashes and browser identities were added
to the paired reports from the original raw trial files after the reviewer
flagged missing identity metadata.

The checkpoint stress test now uses a real 10,001-edge Ninja graph. It removes the test interval override, uses the CLI default and checks
the actual 10,000-action checkpoint while the last action is still running.
It confirms all 10,000 completed outputs and their Ninja journal entries, stops
the live supervisor, resumes the remaining action without changing those
outputs, then verifies a third invocation does no work. This replaces the earlier progress-record simulation. The final local
suite passed 22 checks with one Linux-only check skipped.

GPT-6 Luna flagged two gaps in the first stress-test revision: configuring the
interval did not test the CLI default, and rerunning a completed graph did not
test checkpoint interruption. Both were corrected in the passing real-Ninja
test. The broader native requirements are listed in [completion-audit.json](completion-audit.json).
