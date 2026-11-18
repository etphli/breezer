# Saved-frame budget experiment

This opt-in source overlay exposes `BreezerSavedFrameBudget`, disabled by
default. It limits unlocked saved compositor frames through Chromium's existing
eviction policy. Locked frames can exceed the requested budget. Pages remain
loaded, but an evicted frame may need repainting when its tab becomes visible.
The overlay also adds a `saved_frame_limit` memory-dump scalar when disabled.

The parameter `maximum_saved_frames` defaults to four and clamps to 1–10.
Controlled comparisons use explicit budgets 1–4 and the same binary with the
feature disabled as their control. No RAM, CPU, speed, image or first-frame
acceptance is implied by source preparation. The earlier O2 experiment is not
evidence for the current PGO build.

Use only an existing, verified, private, quiescent prepared source copy. Preserve
its compiled output and all recovery evidence. The Mac pipeline requires:

```sh
BREEZER_BUILD_DIR=/absolute/path/to/private-stage \
BREEZER_FRAME_BUDGET_EXPERIMENT=1 \
BREEZER_FRAME_BUDGET_PRIVATE_COPY=1 \
./script/build_and_run.sh --build-only
```

The acknowledgement does not prove isolation. Confirm that no build or source
writer uses the copy before preparation. The pipeline rejects installation and
run modes, the default stage, a missing preparation marker and a symlinked output
root. It does not change the chosen GN profile or activate a runtime feature.
Windows cross-build deployment must separately validate its source, plan,
toolchain, profile and stopped worker before applying these bytes.

The preparer validates every source and payload before writing. It creates an
intent marker before replacing source files, verifies all three final hashes,
writes the ready marker, verifies again and removes the intent marker. Retry
with the same overlay inputs resumes known partial states. Unknown contents or
changed marker fingerprints stop without deleting source or output. Keep
interrupted temporary files as evidence.

Default builds reject either marker and the known applied implementation or
test bytes even without a marker. This adds one read-only Python invocation
before a default build. That guard detects this pinned experiment; it is not a
general source-integrity audit. Absent source files and unrelated upstream
versions still follow the existing preparation path. Do not remove markers to
bypass the guard. Recover explicitly or use a separate verified default copy.

No concurrent-write or power-loss durability guarantee is provided. File modes
are preserved; ownership, ACLs and extended attributes are outside the contract.

Run the bounded fixture checker with a directory containing only the three
base files named and hashed in `pins.json`:

```sh
python3 -B script/check_breezer_frame_budget.py \
  --fixture-source /absolute/path/to/three-base-files \
  --work-dir /absolute/path/to/new-fixture-results
bash -n script/build_and_run.sh
```

The checker executes the actual CLI and extracted pipeline conditionals. It
does not run the full pipeline, GN, Ninja, Siso or native tests. Native behavior,
current PGO compilation, foreground reveal and full performance acceptance
remain separate requirements.
