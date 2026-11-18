# Exact filter source overlays

Apply these overlays only to a new private authoring copy, before generating
compiled lists or the binary engine image. The manifest pins both input and output
bytes. Unknown, partially edited, or upstream-changed modules reject before writes.
Reapplication accepts the exact result. An interrupted atomic per-file application
can resume from a mixture of the two pinned states.

```sh
python3 -B script/apply_breezer_filter_source_overlays.py /path/to/new/source
python3 -B script/apply_breezer_filter_source_overlays.py /path/to/new/source --check
node script/breezer_trusted_scriptlet_tokens.mjs --check /path/to/new/source/third_party/ublock/js
node script/breezer_css_parser.mjs --check /path/to/new/source/third_party/ublock
node script/prepare_breezer_filter_generation_inputs.mjs /path/to/new/source /path/to/new/plan
```

The nine module outputs cover generated trusted-scriptlet names, toolbar setter
deduplication, main-frame request-header capture exclusion, keys-only cache
enumeration, and a private CSS parser entry. The toolbar and
traffic module outputs equal their previously reviewed candidates. Two equivalent
edits to the retained current startup body use the same generated token import and
listener filters. This is an exact source overlay, not a new esbuild run. The full
response handler, redirect-resource half, external worker/admission boundaries,
facade and remaining body bytes are unchanged. A different startup body must get
a newly reviewed overlay or an actual rebundle and new manifest, never fuzzy edits.

Cache key enumeration uses the native keys-only API when available and retains
the value-read fallback for missing, failed or incompatible implementations.
Backend readiness, read barriers, clear state and pending writes keep their
existing order and behavior. The authoring module and embedded startup body use
the same helper and key-union method.

The generated private css-tree entry exports only `parse` and omits the unused
default Lexer construction. It includes css-tree's MIT notice. The original full
vendor module stays unchanged.
`breezer_css_parser.mjs` regenerates the entry from the pinned vendor bytes or
checks its exact result. The consumer import and embedded startup body select
that entry. A new module changes the compiler contract and resource map; native
resource consumers must be rebuilt before a package can use the new map.

Generated data preserves scriptlet registration order and alias expansion. It does
not change the runtime's shared mutable Set. Both compiler-contract entry points
check the generated data against actual resource modules in a fresh Node process
before reading versions or enumerating sources. The new module belongs to the
source contract. The catalog digest binding is excluded with the three other
generated wrappers to avoid a self-reference.

Native startup-body catalogs bind literal storage bytes. The Python applicator
uses those bytes when a startup body exists, matching the native compiler contract.
Its older standalone profile still normalizes its staging hook. The native profile
has a dedicated Python/Node equality check. Runtime freshness, current-trust,
retry and synchronous cache-consume checks remain in `compiled-filter-context.js`.

The source-plan helper emits a proposed contract and build stamp, an empty producer
binding, and a source manifest. It does not create an index, catalog, compiled payload,
image, app or generation receipt. Root must run actual native compiler/image
generation and package verification against this source identity. Old metadata
cannot establish that generation occurred.

The bounded tests are portable and use real source modules in the
[licensed fixture](../../../tests/filter-source-overlays/fixtures/main-port-20261115/README.md).
Its preparer verifies source, license, upstream-input and overlay pins before
creating isolated baseline/candidate copies under `build/main-port-filter/`.
It uses no downloads, browsers or private build directories.

```sh
python3 -B tests/filter-source-overlays/fixtures/main-port-20261115/prepare.py --check
node --test tests/filter-source-overlays/tokens-contract.test.mjs \
  tests/filter-source-overlays/toolbar-behavior.test.mjs \
  tests/filter-source-overlays/toolbar-reduction.test.mjs \
  tests/filter-source-overlays/cache-keys.test.mjs \
  tests/filter-source-overlays/css-parser.test.mjs
node tests/filter-source-overlays/headers.test.mjs
python3 -B tests/filter_source_overlays_test.py
node --test tests/compiled-filter-lists.test.mjs tests/compiled-filter-context.test.mjs
```

The fixture retains 60 baseline JavaScript modules and 62 candidate modules,
the unmodified PSL snapshot and 110 selected header/IP compiled records. This is
a partial test inventory, not the historical 173-source production contract.
Header tests execute the actual filtering engine against the selected records;
they do not compile full lists or verify native wire behavior. Native generation,
full source/resource closure, response-body filtering and package/runtime checks
remain required for the integrated source. No performance or release acceptance
follows from these offline tests. The parser tests compare actual AST/error and
filter-parser results, including the embedded parser; the cache tests execute the
real key-enumeration method with controlled storage responses. These bounded
checks do not measure browser RAM or establish native API availability.
