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

## Final integration and packaging

The configured Windows PC completed the first 1.2.5 incremental compilation with
300 of 300 actions and exit code zero. Prepared source, compiled objects and the
existing graph were preserved. That artifact is bound to source commit
`1c788b8ef923b49a9734f8e7cfb025d99e54bbd5`; it is not yet the final release package.

The latest main branch adds assistant file attachments. The resolved integration
passed 556 Node checks: 554 passed, zero failed and two skipped. Both assistant
and research browser walkthroughs passed, including file selection, dropping,
removal, validation, attachment-only messages, retry and follow-up context.
The historical RAM comparison fixture retains its original bytes. Final resource
refresh, app packaging, signing, Mac runtime checks and installer verification
must cover this integrated source before publication.

The user has explicitly authorized merging PR #17 and publishing 1.2.5 after
verification. This does not authorize replacing the installed Mac app. Profiles,
passwords, prepared source and required compiled caches remain preserved. All
worktrees owned by the RAM-reduction thread and its descendants are excluded
from cleanup. The older 1.2.1 release hold remains intact.

Native physical interaction, menus, restoration, auto-hide, live provider
execution and the translation window bridge remain separate acceptance checks.
