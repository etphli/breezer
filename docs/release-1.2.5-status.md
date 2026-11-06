# 1.2.5 source and build status

The user requested version 1.2.5, a push of PR #17 and a build on the configured
Windows PC. They asked the main agent to write the update log without another
Opus review. This replaces the earlier plan for a further design council.

`release-info.js` and the extension manifest both name 1.2.5. Native branding and
packaging derive their public version from that same source. The update page
retains the 1.2.0 edition and the 1.2.1 notes, then appends an illustrated 1.2.5
section, including a short account of the implementation, capture and review process. Its expanded list covers settings, themes, memory, assistant controls,
research, tabs, native chrome, new tabs, setup, translation, editorial pages and
verification. Earlier measurements keep their original build labels and limits.

The last independent reviews scored 9.8 and 9.7. The latter identified a clipped
folder disclosure mark at the smallest compact-sidebar width. The final fix
keeps the mark inside that rail without moving the folder icon. Browser checks
cover every supported font size and both folder states. Actual native-host
renderer evidence uses an explicitly scoped CSS resource override, with all
served resource hashes verified. It is not a new release build or an OS-window
capture. The reviewers have not rescored this final correction or release copy.

## Build and release verification

The configured Windows PC completed native compilation with 300 of 300 actions
and exit code zero. A six-action resource refresh then integrated main's file
attachments. The prepared source, compiled objects and existing graph were
preserved. The final 320px translation stylesheet correction was packed on the
Mac with Chromium's GRIT DataPack compiler after the PC connection dropped.
Only that resource changed; all other 5,890 payloads remained byte-identical.
The additional PC CSS build was launched, but its outcome is not claimed.

The combined Node suite passed 554 of 556 checks, with zero failures and two
explicit skips. Both assistant and research browser walkthroughs passed,
including file selection, dropping, removal, validation, attachment-only
messages, retry and follow-up context. The historical RAM comparison fixture
retains its original bytes. The targeted translation run passed ten checks,
with one opted-in live-provider skip. Password component and virtual WebAuthn
checks pass after correcting a stale fixture selector and signing-limit copy.
The behavior received two rounds of GPT-6.1 Sol review and approval.

The private Apple Silicon app passes deep strict signature, identity,
architecture and six headless runtime checks. All 50 compiled extension
resources match current UI source, and all twelve packaged host modules match
source. The verified DMG mounts read-only and contains the same 375 file and
symlink entries as the signed candidate. The updater accepts its identity,
architecture and signature. Signing is ad hoc, not Apple notarized.

The installed 1.2.0 updater is byte-identical to current source and uses its
existing runtime with startup acknowledgement. Nineteen updater startup,
rollback and lifetime tests pass. Publication waits for green GitHub checks.
The release assets provide final checksums, build provenance and update identity;
see the [1.2.5 release](https://github.com/etphli/breezer/releases/tag/v1.2.5).

The user authorized merging PR #17 and publishing 1.2.5. The installed Mac app,
profiles, passwords, prepared source and required compiled caches remain
unchanged. All RAM-thread worktrees and descendants are excluded from cleanup.
The older 1.2.1 release hold remains intact. Native physical input, menus,
restoration, auto-hide, live provider execution and translation's native window
bridge remain outside this verification. No new browser performance claim is made.
