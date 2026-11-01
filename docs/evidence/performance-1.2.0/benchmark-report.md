# Completed matched browser benchmark

Six balanced rounds;36scored launches and18untimed setups. All foreground checks passed. Medians follow; complete ranges and coverage are in presentation-data.json.

| Metric | Installed baseline | Candidate | Chrome |
| --- | ---: | ---: | ---: |
| Initialized-profile usable startup | 730.4 ms | 742.1 ms | 734.9 ms |
| Reused-profile usable startup | 846.6 ms | 861.3 ms | 1070.2 ms |
| Blank-tab readiness | 65.0 ms | 68.8 ms | 66.2 ms |
| Product new-tab readiness | 99.2 ms | 98.8 ms | 198.7 ms |
| Local-page navigation readiness | 33.9 ms | 48.9 ms | 33.1 ms |
| Local-page loadEventEnd | 11.5 ms | 11.2 ms | 6.6 ms |
| First local navigation after tab exercises | 717.4 ms | 262.2 ms | 52.4 ms |
| One-tab process-tree RSS | 1245.5 MiB | 1417.6 MiB | 1418.3 MiB |
| Ten-tab process-tree RSS | 2560.8 MiB | 2756.1 MiB | 2515.1 MiB |
| One-tab macOS physical footprint | 461.3 MiB | 454.8 MiB | Unavailable |
| Ten-tab macOS physical footprint | 956.2 MiB | 959.5 MiB | Unavailable |

Candidate product-new-tab readiness and reused-profile startup are lower than Chrome, but those strengths mostly predate this update. The first local-navigation pause is lower than the installed baseline but remains higher than Chrome. Overall navigation and ten-tab RSS regress; do not imply universal gains, all-faster browsing, or lower whole-browser RAM.

All36settled CPU windows unavailable because observed CPU did not exceed aggregate counter uncertainty. No comparative CPU/battery/energy claim.

Unavailable summaries:49/60native samples observed,7missing/too-recent process identities,2tree changes,2missing native identities/counters. Never pool only the observed samples.

- Six rounds on one M1 Mac; descriptive medians and ranges, no statistical significance claim
- Startup is initialized/reused-profile, not OS-cold boot; no cache flushing
- Local deterministic navigation fixture, not a general internet-speed claim
- RSS sums process resident sets and may double-count shared pages; it is not unique RAM
- Footprint is charged macOS process-tree footprint, including compressed/swapped pages; preserve unavailable values
- CPU windows cover only stable observed processes, not complete app CPU, energy or battery life; do not compute CPU efficiency ratios
- Exact private ad hoc candidate includes combined1.2.0source plus performance/storage changes; functional feature acceptance and release identity still pending
- Earlier v7 setup attempt failed before scoring and remains preserved; never pool it with this v8 run
- No comparative speed claim may use the PC compiler batch benchmark
