# Filter source fixture

This is a bounded offline test fixture, prepared from the retained November 15
source pins. It contains 60 real JavaScript modules and their version inputs.
The candidate is built from those bytes by the production overlay applicator.
No engine functions are replaced. It is a partial compiler inventory, so its
62-module candidate contract is not the full 174-module production candidate
and cannot establish package or generation readiness.

The static import closure starts at `static-net-filtering.js`,
`static-filtering-io.js`, `filtering-context.js`, `publicsuffixlist.js` and
`trusted-tokens.js`. Additional text-only inputs are the exact overlay targets,
`background.js`, `vapi-background-ext.js`, `tab.js`, `pagestore.js`, `storage.js`
and `cachestorage.js`.
The entire flattened startup body is retained because the production overlay
pins its whole input and output. The tests evaluate only the relevant sections.
UI modules, extension HTML, generated image wrappers, app resources and unrelated
compiler modules are omitted.

`manifest.json` pins every retained source, data file and license notice. Each
module records its original path, retained compiler-contract hash and source
ledger input. The upstream lock and current `deps.ini` are also checked. They pin
uBlock 1.75.0, archive SHA-256
`49214674f7c6c474e60da647c05bd28463b1f7a55b2a2b0a53e9d297ef7bf3c6`.
Prepared modules include local changes. Their individual contract pins describe
the actual bytes; the archive pin alone cannot reproduce those transformations.
No network access or private original checkout is required to run the tests.

`headers/header-records.txt` contains only the 110 header/IP records selected
from the eleven retained compiled lists, in their original order within each
compiled block. Every selected record was checked against its original list and
that list's saved SHA-256. The manifest records those list pins and the extraction
input hash. This fixture does not contain the full lists or claim that eleven
lists were compiled during a test. The Public Suffix List is the unmodified
2026-09-15 snapshot, commit `3955e3ec29b94c3cca7bd4509c5f14a7c0959e26`.

uBlock and the derived compiled uAssets records use GPL-3.0-or-later. The
Public Suffix List data retains its MPL-2.0 source notice and license URL.
`publicsuffixlist.js` offers GPL-3.0 or Apache-2.0; this fixture uses GPL-3.0.
The CSS Tree and Punycode MIT notices and RegexAnalyzer's author permission
are in `LICENSES/`. Original module copyright notices remain intact.

`python3 -B tests/filter-source-overlays/fixtures/main-port-20261115/prepare.py --check`
checks source, inventory, license and upstream pins without writes. Without
`--check`, it creates an isolated pair under `build/main-port-filter/`, verifies
the production overlay result and prints its path. Tests share one pair per
process and keep mutation controls separate. Outputs are retained for inspection.
