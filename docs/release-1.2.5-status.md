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

## PC build waits for the user

The single bounded SSH readiness check on November 6 timed out during banner
exchange. No build, remote task or source migration was started. Do not poll or
retry until the user says the PC is on.

After that message, follow [the configured-PC runbook](pc-build.md). Inspect the
existing task and source pins first. Preserve active work, the prepared source,
compiled objects, graph and caches. Stage the current UI assets, native UI
overlays and 1.2.5 version identity through a checked migration before starting
the incremental task. The previous memory-only packet is not this UI release.
Retrieve and verify the resulting artifact, package it with 1.2.5 metadata,
check signatures and run the applicable acceptance checks. Do not relabel a
previous binary as this completed build.

The installed Mac app, profiles, passwords and compiled caches remain unchanged.
This PR push is source publication. No GitHub release, tag, installer publication
or local installation is included. The older 1.2.1 release hold remains intact.
Native physical interaction, menus, restoration, auto-hide, live provider
execution and the translation window bridge remain separate acceptance checks.
