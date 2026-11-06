# Final 1.2.5 checks

This folder records the final compact-folder correction, release-page update and
PC build handoff. It supplements the preceding candidate evidence without
rewriting its manifests or source hashes.

The folder arrow stays inside the 42-pixel rail at every supported text size.
Before: 36 clipped cases out of 144. After: zero clipped cases out of 144.
All 28 palette/mode/folder-state cases pass, and eleven workspace browser tests
pass. The native host produced two identical renderer images at the expected
geometry, with the complete arrow. Its manifest expressly records the one CSS
resource override and verified cleanup. This is renderer evidence, not a fresh
release build or a whole OS-window capture.

The last independent scores were 9.8 and 9.7. The final correction and appended
release copy were checked by the main agent, with no further council after the
user requested the PR push. All implementation and release writing in this
revision is by GPT-6.1 Sol.

The version is 1.2.5; the seen-page edition remains 1.2.0. Earlier benchmark
claims retain their original workload and build qualifications. The bounded PC
connection attempt timed out. No build was launched, and it must wait for the
user to say the PC is on. No release installer or installed app was changed.

The final verification JSON records exact test results, hashes and image scope.
