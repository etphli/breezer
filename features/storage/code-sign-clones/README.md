# Signature-clone storage

Chromium keeps an APFS app clone and a hard link to the running main executable
so signature validation still works after an update replaces the app. Breezer
keeps that behavior. This overlay changes ownership and deletion, not signature,
checksum, updater identity or rollback validation.

New clones live in the bundle-ID-specific `code_sign_clone.sessions-v1` namespace.
Each has a private, versioned lease file. The browser takes an exclusive `flock`
before copying any app data and deliberately keeps its close-on-exec descriptor
until process death, including the shutdown interval after the clone manager is
destroyed. Normal exit and forced termination release that lease in the kernel.
No PID lookup or open-payload-file heuristic decides whether a clone is active.

The existing shutdown helper still waits for the parent to exit. It now uses the
same lease-aware deletion as background maintenance after a new clone is ready.
Creation and cleanup use a private root lock, so cleanup cannot race the creation
of a valid ownership record. Sweep work is limited to 256 entries, eight sessions,
8,192 filesystem entries and a 100 ms deadline per invocation. A partially removed
abandoned clone retains its lease marker and can be finished by another sweep.
An individual filesystem operation can exceed the time budget on a slow volume;
the limits are checked between operations.

Cleanup resolves paths through directory descriptors without following symlink
components, rejects unsafe root/lease permissions and hard-linked leases, checks
directory identities, and does not traverse mounted filesystems. Symlinks inside
an abandoned clone are unlinked without following their targets. Missing,
malformed or ambiguous ownership records are retained. Older unmarked clones
remain in the original namespace; the machine-specific recovery script is not
part of this overlay or browser runtime.

Apply or verify the overlay with:

```sh
python3 features/storage/code-sign-clones/apply.py SOURCE_TREE
python3 features/storage/code-sign-clones/apply.py --check SOURCE_TREE
BREEZER_CLONE_SOURCE=PINNED_SOURCE_TREE python3 tests/code_sign_clones_test.py -v
xcrun clang++ -std=c++20 -Wall -Wextra -Werror -I . tests/code_sign_clone_sessions_test.cc -o build/clone-session-test
build/clone-session-test
```

The native harness exercises the shipping lease/cleanup implementation with
real APFS clones, executable hard links, separate processes and forced exit.
These checks do not launch the installed browser or replace it. A full rebuilt
browser and published upgrade still require release verification.

Lock semantics: [Apple's flock manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html).
