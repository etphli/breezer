# Matched 1.2.0 candidate measurements

The candidate, installed Breezer baseline and Chrome completed six balanced rounds on one Apple M1 Mac on AC power: 36 scored launches and 18 untimed setups. All 36 native foreground endpoint checks passed. The report's summaries were recomputed from its raw trials and matched exactly.

- `presentation-data.json` contains all 11 summary rows, ranges, counts, comparisons and coverage limits.
- `raw-results.json.gz` preserves the complete raw JSON, including every CPU/footprint capture. `provenance.json` records the uncompressed and compressed SHA-256 values.
- `component-results.json` contains the separate six-round synthetic saved-record measurements. These are JavaScript source-component results, not thousands of live browser tabs.
- `candidate-identity.json` records private source snapshot, runtime packaging and signature verification. It is an ad hoc benchmark candidate, not a notarized or published release.
- `comparison.png` and the three `whats-new-results*.png` files show the rendered presentation. They are disposable Chrome source fixtures, not physical input or compiled Breezer screenshots.

CPU windows remain unavailable. Chrome's physical-footprint summaries remain unavailable rather than pooling only the successful native samples. The complete table retains navigation and RSS regressions. Highlights name the exact comparator and workload.

The first v7 attempt failed during the new setup guide before any scored launches. V8 uses the actual Skip setup action in untimed initialization and detaches inspected extension contexts. No sample, score or feature setting was patched to make the run pass. The older failed attempt is retained locally in `build/benchmark-1.2.0-three-way-run-20261101` and is not pooled here.

Reproduce the browser comparison using the six-round command in [browser-benchmark.md](../../browser-benchmark.md). All apps must use the same current protocol. Keep failed attempts, slower readings and unavailable captures.

`component-measure.mjs` records the AB/BA source-component procedure. Obtain the baseline module from commit `a1e0491bb0a36f88dcf9e8174c7edc3f28eed09b` and compare it with the candidate's `workspace-store.js` using [benchmark_workspace.mjs](../../../script/benchmark_workspace.mjs). Each process uses 11 internal repetitions; the reported value is the median of six per-process medians. The private snapshot paths in that recorded driver describe the actual run.

The benchmark predates the final 1.2.0 version stamp and presentation changes. Full functional acceptance, final versioned build, signing/distribution and publication remain separate release gates. Installed applications and personal profiles were not replaced.

The native-build, repaired-object and Mac-copy verification files preserve the completed23/23pass, six successfully recompiled error targets and matching artifact hashes. Final1.2.0metadata was added to source after this benchmarked candidate; it has unit and packaging checks but was not recompiled here.
