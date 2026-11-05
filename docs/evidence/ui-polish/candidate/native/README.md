# Native window evidence without Computer Use

The capture helper runs inside a new disposable Breezer process. It uses
ScreenCaptureKit's current-process window API and captures only that process's
windows. Computer Use and screen-recording permissions remain ungranted. Audio
and microphone recording are disabled. Native-host launches are blocked in this
instrumented process to avoid reading global integrations or CLI accounts.

The installed app is unchanged. Executable, framework and identity-file hashes
match before and after each pass. Profiles were removed and every recorded owned
process exited. No unrelated process was stopped and no system setting changed.

`normal/` contains 38 full-window PNGs: seven palettes, light/dark, desktop/narrow
at 1100px/540px, six toolbar configurations, three sidebar frame allocations and
the motion start state. The custom example is #2c79c7. `reduced/` contains one
start window and the equivalent continuous recording with Chromium's native
reduced-motion switch and renderer preference. macOS accessibility settings were
unchanged. Both folders retain the MP4, eight decoded samples, header contact
sheets, geometry, action timestamps and process/cleanup records. Header sheets
are cropped indexes; original PNGs contain the complete native window.
The recordings show a small title-bar badge absent from the settled captures.
Use the settled PNGs to judge ordinary window controls.

These are the installed 1.2.0 native runtime, rather than a fresh candidate build.
Its reported source commit is 6bbe560a9bdb4fa0f91b5aad7ed975ee4f862fb5. Native
workspace/frame inputs and the upstream source tree match this worktree. The
resource commit stamp is not a reproducible compiled-binary attestation. The
installed web UI is older; sidebar web content and fictional page content are
excluded from the candidate web-UI assessment. Native tabs, toolbar geometry and
the recorded native transitions can now be judged directly with that provenance.

Physical mouse hit testing, menus, restoration, physical auto-hide, translation
native geometry/bridge and broader macOS integration remain unverified. Clips do
not measure input latency or certify frame pacing. Provider execution is outside
these loopback-page captures.

Reproduce on macOS 15 or newer with Xcode command-line tools and pinned Playwright.
Output directories must be new. `BREEZER_NATIVE_RESUME=1` resumes only a pack whose
installed pins, native inputs and images still match.

```sh
node tests/ai/native-ui-capture.mjs /absolute/path/Breezer.app /tmp/breezer-native
BREEZER_NATIVE_REDUCED_MOTION=1 BREEZER_NATIVE_MOTION_ONLY=1 node tests/ai/native-ui-capture.mjs /absolute/path/Breezer.app /tmp/breezer-native-reduced
node tests/ai/native-ui-evidence.mjs /tmp/breezer-native /tmp/breezer-native-reduced
```

The injected library is test code only. It is not included in Breezer releases.
