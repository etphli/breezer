# Compiled filter-list experiment

This experiment skips uBlock's parser/compiler for unchanged packaged lists.
It is opt-in. Packaged native byte checks, existing-cache and saved-engine
restart checks, 640 differential request decisions, concurrent raw-list updates,
and paired cold-filter diagnostics have passed. GUI acceptance remains unfinished.
It is not enabled by ordinary builds. The installed app is unchanged.

`compiled-filter-lists.mjs` owns one operation, `tryLoad`. A hit returns compiled
text; every missing, stale, incompatible or corrupt resource returns a miss.
The caller retains metadata extraction, bad-list suppression, current trust
checks, ordinary compilation on a miss, and the existing compiled-cache write.
Existing cache hits and whole-engine selfies still take precedence. Selection,
updates, user filters, custom/admin lists and cosmetic preferences retain their
existing paths.

The native adapter exposes `read(request, consume)`. It tracks raw-asset changes
during asynchronous reads and calls the storage consumer synchronously with a hit,
miss or retry. The consumer's freshness check and compiled-cache submission share
one JavaScript turn. An asset update during a read retries the normal storage
operation, preventing an older packaged result from overwriting a newer cache.

The generated index binds exact raw UTF-8 bytes to compiled payloads. Its context
includes the source fingerprint of all compiler/runtime JavaScript, exact Chrome
and V8 versions, compiled-format number, preprocessor environment, token length,
response-body capability and trusted-token digest. The runtime checks current
trust before and after asynchronous work. Packaging verifies the source and
engine contract again and emits the build stamp from that contract.

The reader retains the small index. Payload reads are serialized and bounded;
payload strings and raw-list buffers are not kept in a separate persistent cache.
Checksums detect stale or corrupt artifacts within the signed app, and add no
independent trust authority.

## Reproduce

Start with a prepared source tree and a browser built from those exact compiler
sources and engine versions. Generation uses only explicit packaged local asset
URLs in a new disposable profile. It invokes the actual built-in compiler twice
per list and rejects nondeterministic output. It skips network-only lists.

```sh
node script/generate_breezer_filter_lists.mjs \
  --source-dir /path/to/prepared/src \
  --browser /path/to/Breezer.app/Contents/MacOS/Breezer \
  --output /path/to/new-artifacts

python3 script/check_breezer_filter_lists.py \
  --source-dir /path/to/prepared/src --artifacts /path/to/new-artifacts
```

The generator refuses an existing output directory. The checker uses a temporary
source fixture, tests idempotence and compiler drift, runs Chromium's real GRIT,
and compares decoded packed bytes. It also checks the resource-ID reservation
and that implementation resources did not become selectable lists.

Stage the experiment into a separate prepared source snapshot before GN:

```sh
python3 script/apply_breezer_filter_lists.py /path/to/isolated/src \
  --artifacts /path/to/new-artifacts
python3 script/apply_breezer_filter_lists.py /path/to/isolated/src \
  --artifacts /path/to/new-artifacts --check
```

The build wrapper accepts the artifact directory as `BREEZER_COMPILED_FILTERS`.
Use a separate `BREEZER_BUILD_DIR` and `--build-only`. Changed artifacts require a
fresh source snapshot. The wrapper refuses to silently reuse an experimental
tree when the environment variable is absent. Before staging, it rejects the
default build tree, its parents/subdirectories and symlink aliases, and any mode
that would install or launch an app. No workflow here installs an app.

The live component check uses the staged production reader and storage function
inside the actual matching built-in engine. Its own-resource URLs are mapped to
a loopback fixture because DevTools cannot intercept the absent extension
resources in the unmodified app. This checks the seam and browser streaming
reader, with real packed bytes checked separately. It is not packaged native
acceptance or a startup benchmark.

```sh
node script/verify_breezer_filter_lists.mjs \
  --source-dir /path/to/isolated/src --artifacts /path/to/new-artifacts \
  --browser /path/to/matching/Breezer.app/Contents/MacOS/Breezer \
  --output /path/to/component-report.json
node --test tests/compiled-filter-lists.test.mjs
```

After building and signing the native candidate, check its actual packaged
resources and warm paths without resource substitution:

```sh
node script/verify_breezer_filter_lists_native.mjs \
  --source-dir /path/to/isolated/src --artifacts /path/to/new-artifacts \
  --browser /path/to/native/Breezer.app/Contents/MacOS/Breezer \
  --output /path/to/native-report.json
node script/verify_breezer_filter_behavior.mjs \
  --artifacts /path/to/new-artifacts \
  --browser /path/to/native/Breezer.app/Contents/MacOS/Breezer \
  --output /path/to/behavior-report.json
```

This verifies every packaged compiler/runtime JavaScript file against staging,
all generated outputs against the ordinary compiler, changed-text/trust fallback,
and existing compiled caches while both the compiler and reader are set to throw.
It creates a real engine snapshot, waits for the normal asset-registry persistence,
then restarts the blocker and checks snapshot restoration, list selection and
network-filter counts. The profile is disposable. These are functional checks;
the timings in the support record are not a controlled comparison.

The behavior verifier compares the same native build with packaged hits enabled
and forced to miss. It checks 640 request decisions, user/custom/temporary filters,
cosmetic preferences, scriptlets, redirects, query removal, list updates and
selection, bad-list suppression and live trust changes. It also pauses two real
payload reads across a raw-list update, then verifies both returns and the final
compiled cache contain the newer data. It uses disposable profiles and makes no
timing claim.

## Promotion gate

Keep the experiment opt-in until the real packaged candidate passes filtering
and UX checks, changed-list/trust fallback, warm-cache and saved-engine startup, and
paired cold-profile measurements. Compare the same native build with the reader
enabled and forced to miss. Require repeatable cold-filter readiness improvement,
no retained-heap growth above 1 MiB, no process-tree peak-RSS regression above
5%, and compressed package growth below 5 MiB. Repeat final measurements without
competing compilation. These are experiment gates, not achieved results.

Current measurements and their limits are in [docs/performance.md](../../docs/performance.md).
