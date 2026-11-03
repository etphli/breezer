# 1.2.1 benchmark hold

The user requested benchmarks before release and requires at least 20% lower RAM
usage than Chrome. The candidate was briefly published following an earlier ship
instruction, then returned to draft on November 3. All assets and source history
are preserved. Version 1.2.0 remains the stable download. The installed app and
personal profiles are unchanged.

Do not republish 1.2.1 without a new user instruction. Benchmark results alone do
not authorize publication. Keep its installer and release metadata in draft.

The matched comparison uses the verified 1.2.1 candidate, the actual released
1.2.0 app and Chrome on the same Mac. Use six balanced rounds, initialized
temporary profiles, three repetitions, ten tabs, five seconds settling and five
memory samples. Protocol v9 uses the test keychain equally for all apps; native
foreground readiness remains required. Preserve the earlier failed v8 attempt.

The predeclared gate requires candidate physical-footprint medians no greater
than 80% of Chrome for both the one-tab and ten-tab workloads, with every required
capture valid. Unavailable data cannot pass. Report RSS separately, retain all
regressions, and do not claim energy or battery gains from these measurements.

After accepting the complete benchmark evidence, use Claude Opus 5.5 at medium
effort with Fast disabled in a T3-isolated worktree to update the article. No
article publication, installer replacement or release follows automatically.
Working receipts and raw measurements are under `build/benchmark-1.2.1/` and the
release hold is recorded in `build/release-1.2.1/release-hold.json`.
