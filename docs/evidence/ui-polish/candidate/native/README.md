# Native window evidence without Computer Use

ScreenCaptureKit captures only a disposable Breezer process's own windows. Audio
and microphone recording are disabled. The injected test helper allows only that
private app's browser helpers, blocks native host launches and uses a mock
keychain. No installed executable, real profile, account integration, system
setting or permission was changed.

`normal/` has 38 native windows: seven palettes, both modes and 1100px/540px
widths, six toolbar options, three sidebar allocations and a motion start state.
`reduced/` adds one start window and an equivalent continuous recording using
Chromium's native reduced-motion switch and renderer preference. Both folders
retain the MP4, eight decoded samples, contact sheets, geometry, action timestamps
and cleanup receipts. All recorded owned processes exited and disposable
profiles were removed. Header sheets are indexes; original PNGs are full windows.
A small title-bar badge appears only while recording.

These fresh captures use a private UI verification build. The retained Chromium
156.0.8078.47 core reports Breezer 0.20.1.1. Nine translation units were freshly
compiled, covering current frame/workspace/avatar UI, the appearance bridge and
schema, and the current 50-file UI resource mapping. Matching retained core data
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
palette/mode states. The collapsed auto-hide edge is clean. This is a visual
asset check, not a comprehensive accessibility audit.

Physical mouse hit testing, menus, restoration, physical auto-hide, translation
native geometry/bridge and broader OS integration remain unverified. Video
samples establish neither smoothness nor input latency or frame pacing. Provider
execution is outside these loopback captures. Capture and private-build receipts
are retained alongside the frozen evidence; no verification library ships in the
product.
