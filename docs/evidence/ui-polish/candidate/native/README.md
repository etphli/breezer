# Native window evidence without Computer Use

ScreenCaptureKit captures only a disposable Breezer process's own windows. Audio
and microphone recording are disabled. The injected test helper allows only that
private app's browser helpers, blocks native host launches and uses a mock
keychain. No installed executable, real profile, account integration, system
setting or permission was changed.

`normal/` has 40 native windows: seven palettes, both modes and 1100px/540px
widths, six toolbar options, three sidebar allocations, a motion start state, and both compact-sidebar font-size endpoints.
`reduced/` adds one start window and an equivalent continuous recording using
Chromium's native reduced-motion switch and renderer preference. Both folders
retain the MP4, eight decoded samples, contact sheets, geometry, action timestamps
and cleanup receipts. All recorded owned processes exited and disposable
profiles were removed. Header sheets are indexes; original PNGs are full windows.
A small title-bar badge appears only while recording.

These fresh captures use a private UI verification build. The retained Chromium
156.0.8078.47 core reports Breezer 0.20.1.1. Nine verified current UI/resource units cover the frame/workspace/avatar UI,
appearance bridge/schema and resource mapping. All nine unchanged current UI units were reused from the preceding private UI
build. No new native translation unit was required for this refinement. All fifty web resources were repacked and signed for this capture. Matching retained core data
and V8 snapshot accompany that core. Every current UI resource was fetched and
hashed through the actual component-extension origin before capture. Settings
patches round-trip through the real native API for each recorded state.

The app shell's inherited 1.2.0 metadata and old resource commit stamp do not
identify this private framework. This is not a full product/release rebuild or a
reproducible binary attestation. The installed 1.2.0 app was unchanged. Build,
source and asset provenance are recorded in `normal/ui-build-provenance.json`.
The current candidate sidebar document is included; fictional page content is
excluded from the design assessment.

Native placeholder profile icons now use the toolbar foreground. Actual solid
stroke samples versus adjacent background exceed 8.8:1 across all fourteen
palette/mode states. Graphite uses a grayscale frame, and the collapsed auto-hide edge is clean.
The sixteen supplied normal/reduced samples retain the native plus button as it
moves after tab close; the close-up sheet makes those positions inspectable. This is a visual
asset check, not a comprehensive accessibility audit.

Physical mouse hit testing, menus, restoration, physical auto-hide, translation
native geometry/bridge and broader OS integration remain unverified. Video
samples establish neither smoothness nor input latency or frame pacing. Provider
execution is outside these loopback captures. Capture and private-build receipts
are retained alongside the frozen evidence; no verification library ships in the
product.

Earlier candidate captures encountered intermittent macOS stream-stop errors;
their failure manifests are retained separately. Both recordings in this pack
passed with the diagnostic stream delegate. That earlier recorder failure's cause
remains unresolved; no product fix is claimed.

The `dense/` folders contain every encoded frame's native header, decoded with
AVAssetReader and actual presentation timestamps: 42 normal and 36 reduced.
Unknown sample durations are recorded as null. The source MP4s remain unchanged.
Recorders may omit unchanged images, so timestamp gaps are not app frame pacing.
The two dense contact sheets index the original pixel strips.
