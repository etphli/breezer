# Breezer update queue

Use the queue for releases after 1.3.7. The 1.3.7 draft keeps its existing release notes.

## Schedule a request

When the user says "put this in the next update," run the queue command from the repository root. Record the requested outcome and how an agent can verify it. Include relevant issue, PR or thread links in the details.

```sh
python3 script/breezer_update_queue.py add sidebar-search \
  --title 'Search sidebar tabs' \
  --details 'Find open tabs by title. Verify that selecting a result focuses its tab.'
python3 script/breezer_update_queue.py list --target next
```

Report the item ID and target shown by the queue. Use `--target 1.4.0` when the user names a version. `next` waits for the next release plan. If a plan is already active, new `next` items wait for the following plan. To join the active release deliberately, use its version as the target.

After implementing and verifying an item, record the commit that contains the verified work and summarize the checks. If the PR was squash-merged, use the merged commit after confirming it contains the verified change.

```sh
python3 script/breezer_update_queue.py ready sidebar-search --commit HEAD \
  --evidence 'Sidebar interaction tests passed. Selecting a result focused its tab in the candidate.'
```

Use `move ID --target VERSION --reason '...'` to reschedule an item. Use `next` to return it to the next unplanned release or `backlog` to leave it unscheduled indefinitely. The queue keeps the latest move reason and any existing verification.

## Prepare and close a release

1. Run `python3 script/breezer_update_queue.py plan VERSION` once the release version is chosen. It assigns waiting `next` items to that version. Review them with `list --target VERSION`. Finish the work or explicitly move each item that needs more time. Use `abandon VERSION` if the release plan is called off. It returns automatically assigned items to `next` and keeps explicit version assignments.
2. Stamp and commit the version using the normal release workflow. Run `python3 script/breezer_update_queue.py check VERSION --ref COMMIT` on the exact source commit to publish. Resolve every blocker. The check validates release metadata, overdue targets and verified commit ancestry. The candidate still needs the tests and artifact checks in [RELEASE_POLICY.md](../RELEASE_POLICY.md).
3. After publication and artifact verification, run `python3 script/breezer_update_queue.py ship VERSION` with the published `vVERSION` tag available locally. The queue checks the tagged commit and keeps the shipped items in its history.

The SQLite queue lives in Git's shared metadata directory. It persists across local threads, restarts and linked worktrees of this clone. Independent clones and machines each have their own queue. When building elsewhere, fetch the candidate commit and release tag into the clone that owns the queue and run the queue checks there.
