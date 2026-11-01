# Efficiency changes in the combined 1.2.0 candidate

Draft for the update page, mainly written for Ethan. It describes a private
candidate build, not a published 1.2.0 release. The HTML version for the update
page is `build/benchmark-1.2.0-presentation/efficiency-article.html`.

## Article

### What we changed to reduce work

Most of this work removes repeated effort. It did not make the whole browser
faster, and some results got worse.

Restoring saved tabs used to compare each open tab with every saved record. It
now builds a lookup index once per operation, and the sidebar model uses an
index of saved entries too. With 1,000 synthetic saved records, matching fell
from 190.0 ms to 2.9 ms and model building from 3.30 ms to 0.19 ms. That is
JavaScript work on stored records, not 1,000 live tabs or overall browser speed.

Sidebar rows keep their elements when nothing visible changed, so keyboard
focus stays put. Organato's helper starts on first request, is shared between
pages and exits when idle. The updater helper is also released when idle, and
AI provider code loads only when needed. Built-in filter lists can load from
checked, prepared copies, with the normal compiler as fallback. The build also
used Chromium's Apple Silicon profile-guided optimization (PGO). None of these
was measured alone in the browser comparison, so none gets individual credit.

Against the installed Breezer, the first local page load after opening and
closing tabs fell from 717.4 ms to 262.2 ms. Chrome took 52.4 ms, so the pause
is shorter but not gone. New tabs (98.8 ms against Chrome's 198.7 ms) and
reopening an existing profile (861.3 ms against 1,070.2 ms) stay faster than
Chrome, but the installed Breezer already had that lead.

Two results regressed. Typical local navigation rose to 48.9 ms, against
33.9 ms for the installed Breezer and 33.1 ms for Chrome. Summed process memory
(RSS) with ten tabs reached 2,756.1 MiB, against 2,560.8 MiB and 2,515.1 MiB.
With one tab, RSS matched Chrome but exceeded the installed Breezer. The macOS
memory footprint barely moved. CPU readings were too small to measure reliably,
so there is no CPU or battery claim.

Next: find the causes of the navigation and memory regressions, trace the
remaining first-load pause and get a valid Chrome footprint. Feature acceptance
and the signed release build are also unfinished.

<!-- Article body: 339 words, excluding the heading. -->

## Full browser results

Medians, with minimum–maximum in brackets. Same session on one Apple M1 Mac
(8 GB RAM, macOS 26.7), AC power, six balanced rounds, 36 scored launches plus
18 untimed setup launches, all 36 foreground checks passed. "Installed Breezer"
is the app at `~/Applications/Breezer.app`; "Candidate" is the combined 1.2.0
candidate. Both report internal version 0.20.1.1. Chrome is 156.0.8078.47.
Lower is better in every row.

| Metric | Unit | Candidate | Installed Breezer | Chrome | n per app | Reading |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Initialized-profile usable startup | ms | 742.1 [712.8–851.2] | 730.4 [720.8–762.6] | 734.9 [671.0–877.7] | 6 | About even across all three |
| Reused-profile usable startup | ms | 861.3 [784.9–990.3] | 846.6 [764.0–1026.2] | 1070.2 [1010.3–1754.7] | 6 | 19.5% below Chrome; already true of the installed Breezer |
| Blank-tab readiness | ms | 68.8 [50.0–228.3] | 65.0 [49.4–84.3] | 66.2 [41.5–82.8] | 18 | Near parity; candidate median slightly higher |
| Product new-tab readiness | ms | 98.8 [78.1–216.5] | 99.2 [81.1–148.9] | 198.7 [149.5–249.2] | 18 | 50.3% below Chrome; already true of the installed Breezer |
| Local-page navigation readiness | ms | 48.9 [31.9–453.0] | 33.9 [31.3–792.8] | 33.1 [31.1–71.7] | 18 | **Regression** against both |
| Local-page loadEventEnd | ms | 11.2 [9.1–416.7] | 11.5 [10.4–754.1] | 6.6 [5.3–9.8] | 18 | Unchanged against the installed Breezer; above Chrome |
| First local navigation after tab exercises | ms | 262.2 [154.9–453.0] | 717.4 [703.8–792.8] | 52.4 [35.5–71.7] | 6 | 63.5% below the installed Breezer; still 5× Chrome |
| One-tab process-tree RSS | MiB | 1417.6 [1250.9–1439.4] | 1245.5 [1204.0–1349.8] | 1418.3 [1349.5–1518.0] | 6 | Parity with Chrome; 13.8% above the installed Breezer |
| Ten-tab process-tree RSS | MiB | 2756.1 [2658.9–2837.4] | 2560.8 [2524.8–2652.1] | 2515.1 [2426.3–2568.1] | 6 | **Regression** against both |
| One-tab macOS physical footprint | MiB | 454.8 [446.6–484.7] | 461.3 [450.9–472.7] | Unavailable | 6 | Within run-to-run spread of the installed Breezer |
| Ten-tab macOS physical footprint | MiB | 959.5 [946.9–966.1] | 956.2 [952.8–976.4] | Unavailable | 6 | Within run-to-run spread of the installed Breezer |

CPU: all 36 settled CPU windows are unavailable because observed CPU did not
exceed the counters' uncertainty. No CPU, energy or battery comparison follows.

Chrome footprint is unavailable: 49 of 60 native samples were observed; 7 had
missing or too-recent process identities, 2 saw the process tree change and 2
lacked native identities or counters. The protocol requires every observation,
so the valid Chrome samples are not pooled, and RSS is not a substitute.

"First local navigation after tab exercises" is the first of three local
navigations after each launch's new-tab and blank-tab exercises: six
observations per app. It is a controlled local fixture, not general website or
OS-cold-boot speed.

## Saved-record component results

A separate synthetic Node benchmark, independent of the browser runs above.
It compares `workspace-store.js` from installed baseline source `a1e0491` with
the candidate source snapshot. Six alternating AB/BA rounds, 11 internal
repetitions each and 20 model builds per observation; Node 22.14.0. Medians of
the six round medians.

| Saved records | Restore matching, before → after | Sidebar model, before → after |
| ---: | ---: | ---: |
| 10 | 0.149 → 0.079 ms | 0.0072 → 0.0051 ms |
| 100 | 2.527 → 0.586 ms | 0.0486 → 0.0284 ms |
| 500 | 48.068 → 1.721 ms | 0.809 → 0.092 ms |
| 1,000 | 189.956 → 2.902 ms | 3.299 → 0.187 ms |

These are synthetic saved records processed in JavaScript. They are not live
tabs, page loads or a whole-browser multiplier.

## What the article does and does not claim

- **Measured in the browser comparison:** the 11 rows above, as observed in this
  run only. Six rounds give descriptive medians and ranges, not statistical
  significance.
- **Measured separately:** saved-record restore and model construction.
- **Present in source, not individually measured in this run:** unchanged-row
  reuse, on-demand/shared/idle-released helpers, on-demand AI provider loading,
  prepared filter lists with fallback and PGO. Earlier component diagnostics in
  [performance.md](performance.md) describe some of them under older protocols;
  they are not re-attributed here.
- The improvement in the first navigation is not credited to any single
  change. Earlier tracing tied the old pause to filter-engine startup work, but
  that never proved its exact cause, and a valid existing compiled cache can
  bypass the prepared-list reader.
- Startup is initialized or reused-profile, not OS-cold boot, and caches were
  not flushed.
- RSS sums each process's resident memory and can double-count shared pages.
  Physical footprint is a separate macOS measure that includes compressed and
  swapped pages. Neither is battery life.
- The PC compiler batch benchmark measures build throughput and supports no
  browser-speed claim.

## Candidate identity and remaining gates

- Source: private combined snapshot `fa19c374cfe28ca3c083ce28c1fdbc3e36c5a19a`
  on main base `5d1db7fb7d8283fc5b41b0b2764281315307f74c`, with matching packaged
  host/runtime. PGO build output with pinned profile SHA-256 `15fbc265…0c20`.
- Signing: ad hoc development signature, deep strict verification passed, not
  notarized. App metadata still reads 0.20.1.1.
- Pending: native release identity and version, full functional feature
  acceptance (including encrypted two-profile sync acceptance), final filter
  promotion checks and public release. Nothing here is installed or published.
- [The release inventory](release-1.2.0-inventory.md) tracks the remaining native and release acceptance gates. The version metadata and update-page work added after measurement are not part of the timed snapshot.

## Evidence

- Browser summary: [presentation-data.json](evidence/performance-1.2.0/presentation-data.json)
- Browser report: [benchmark-report.md](evidence/performance-1.2.0/benchmark-report.md)
- Raw browser trials: [results.json](evidence/performance-1.2.0/raw-results.json.gz)
  (SHA-256 `9de536bf…acb3a`)
- Harness provenance: [harness-provenance.json](evidence/performance-1.2.0/harness-provenance.json)
  (protocol `installed-browser-v8-initialized-three-way-footprint`)
- Candidate identity: [benchmark-candidate-packaged.json](evidence/performance-1.2.0/candidate-identity.json)
- Component results: [results.json](evidence/performance-1.2.0/component-results.json)
  and [measure.mjs](evidence/performance-1.2.0/component-measure.mjs)
- Source rationale: [performance.md](performance.md),
  [features/performance/README.md](../features/performance/README.md)
