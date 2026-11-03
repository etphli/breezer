# Breezer build PC

This is the runbook for Ethan's configured Windows PC. The optional progress
square was activated at the user’s request and counts finished actions upward. It
has no login trigger and can be opened explicitly for future builds.

## Locations and limits

| Item | Location or setting |
| --- | --- |
| Windows SSH | `ethan@100.107.233.126` over Tailscale |
| Windows storage | `B:\BreezerBuild`, Toshiba external USB drive, NTFS |
| WSL distribution | `BreezerBuild`, WSL2, Ubuntu 24.04.5 |
| Linux build user | `breezer`, not root |
| Linux VHD | `B:\BreezerBuild\Linux\ext4.vhdx` |
| Source inside WSL | `/home/breezer/builds/breezer-1.2.0-pc/src` |
| Incremental output | `/home/breezer/builds/breezer-1.2.0-pc/src/out/PCMacPerformance` |
| Expected browser executable | `Breezer.app/Contents/MacOS/Breezer`, inside that output |
| Windows build task | `Breezer-PC-Build-Trial` |
| Task entry point | `B:\BreezerBuild\setup\continue-pc-browser-compile.ps1` |
| Linux worker | `/mnt/b/BreezerBuild/setup/pc-browser-build.py --resume-build-graph` |
| Live state | `B:\BreezerBuild\logs\pc-browser-build-state.json` |
| Live log | `B:\BreezerBuild\logs\pc-browser-build.log` |
| Pinned input manifest | `B:\BreezerBuild\setup\combined-1.2.0-inputs.json` |
| Optional square | `B:\BreezerBuild\setup\progress\show-build-progress.ps1` |
| WSL configuration | `C:\Users\ethan\.wslconfig` |
| WSL limits | 10 GB RAM, 16 logical CPUs available, 16 GB swap on B: |
| Normal concurrency | Four Ninja jobs, one link slot |

The output is an experimental Linux-to-macOS arm64 browser build. A successful
compile does not establish packaging, signing, Mac runtime or feature acceptance.
The previous combined pass included the merged feature batch and completed at
23/23 actions with no failures. Its native artifacts were copied and hash-verified
on the Mac. The incremental memory-optimization pass started on November 3 at
16:38 Sydney time and completed at 16:46 with task result zero and an output
hash recorded in the worker state. The new app was retrieved, packaged and
passed headless Mac smoke checks. The DMG payload and signatures were verified
on a read-only mount. Physical-input and whole-browser RAM/CPU acceptance remain
open. Never inject source changes or regenerate the graph during a live pass.

Never reformat this drive. Preserve source, objects, caches, profiles and failure
logs. The Mac build and its automations remain stopped by the user's instruction.
Do not install or replace the Mac's installed Breezer as part of this workflow.

## Connect from this Mac

The Mac already has a dedicated SSH key at `~/.ssh/breezer_windows_ed25519` and a
pinned host-key entry in `~/.ssh/known_hosts`. Neither private key material nor
credentials belong in this repository. Both machines need their Tailscale link.

Open PowerShell over SSH. Reuse the key, proxy and host checks for SCP and SFTP:

```sh
ssh -t -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes \
  -i "$HOME/.ssh/breezer_windows_ed25519" \
  -o 'ProxyCommand=/Users/likht.ethan/.local/share/remote-desks/tools/tailscale-1.104.1/bin/tailscale --socket=/Users/likht.ethan/.local/share/remote-desks/tailscaled.sock nc %h %p' \
  ethan@100.107.233.126 powershell.exe -NoLogo -NoProfile
```

Do not accept a changed host key without verifying it. The native Windows SSH
service is `sshd`; it can remain available with Ubuntu stopped. If access fails,
check Tailscale and `Get-Service sshd` on the PC rather than repeatedly rebooting.

For scripted read-only checks, use the tracked connection helper:

```sh
cd /Users/likht.ethan/.t3/projects/breezer
python3 script/windows/windows-command.py --probe /path/to/check.ps1
```

`--probe` enforces a 40-second deadline in the remote PowerShell itself and a
60-second local SSH timeout. Use it for read-only checks only. A local SSH timeout
alone can leave a remote PowerShell alive. Do not use this deadline wrapper to
launch a long-running build or the progress square.

Pinned input manifests, generated pipeline scripts and historical build records live under
the ignored `build/windows-crossbuild-20261031` directory. This runbook is not a
provisioner for another PC; retain that machine-local directory and SSH setup.
The reusable progress implementation is tracked in `script/windows`.

## Resume the existing build when needed

Run the following in Windows PowerShell, locally or in the authorized SSH
session, only when deliberately resuming this same prepared build:

```powershell
$task = Get-ScheduledTask -TaskName 'Breezer-PC-Build-Trial'
if ([string]$task.State -eq 'Running') { throw 'Build already running; leave it alone' }
if ([string]$task.State -ne 'Ready') { throw 'Inspect task/state/error logs before starting' }
Start-ScheduledTask -InputObject $task
```

The task starts the owned distribution for concrete compilation and runs as
`breezer`. It uses `ninja ... chrome chromedriver -j4 -k0`. Do not run another
Ninja beside it. Resumption skips retained completed outputs. The driver still
needs to read the existing graph before it can print new action counts.

The worker checks pinned source, the PGO profile and existing graph. Its paging
guard may reduce jobs from 4 to 2 to 1 after sustained real pressure, with a bounded
cooldown and no output cleanup. It stops if one job remains unsafe. Compiler or
tool failures are not automatically retried. With `-k0`, independent work can
continue after an action fails, but the full build still fails.

The Linux host Dawn toolchain also requires `libx11-xcb-dev`, which supplies
`/usr/include/X11/Xlib-xcb.h`. The host-library provisioner checks that header.
Keep this dependency even though the final browser targets macOS. A missing
host header is not a reason to disable a browser feature or change compiler
flags.

During the November1 Xlib repair, an owned one-time task named
`Breezer-Continue-After-Xlib-Repair` waited for the current runner to exit
naturally, checked that only the repaired errors remained and started the same
incremental build task once. That helper completed and is disabled. It has no login/time triggers and disables itself
after its handoff. Do not use it as a normal build starter. Cancel and disable
this queued helper before any later user-requested pause or stop.

Inspect state without waking Linux:

```powershell
[IO.File]::ReadAllText('B:\BreezerBuild\logs\pc-browser-build-state.json')
Get-ScheduledTask -TaskName 'Breezer-PC-Build-Trial' | Select-Object TaskName,State
```

Do not use unbounded PowerShell log-tail pipelines. The scheduled health check
uses `pc-bounded-health-snapshot.ps1` and `.py`, already in the local build-support
directory. It checks actual processes, useful CPU work, memory, paging, I/O,
errors and disk space. A live task or unchanged counter alone proves no health
verdict. The agent check uses a 30-minute interval when enabled. It is disabled
after the November 3 compile completed. The new output was retrieved and packaged
after Ethan's explicit packaging request. The square is independent.

Do not change `.wslconfig` or restart WSL during owned work. Keep the old
`Breezer-Prepare-Linux` and `Breezer-Prepare-Cross-Toolchain` tasks disabled,
including their old login triggers. Never enable Mac build automations.

The build task starts Ubuntu when needed. After all owned build, setup and test
work has exited, Ubuntu can be stopped with `wsl --terminate BreezerBuild`.
Do not terminate it while any owned work is active, and do not start it just to
read the Windows log, state file or progress square.

## Open the optional progress square later

Use **PowerShell on the PC's visible desktop**, not an SSH session. SSH normally
does not put windows on the logged-in desktop. The files are already copied into
`B:\BreezerBuild\setup\progress`, but nothing auto-starts them.

```powershell
powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File 'B:\BreezerBuild\setup\progress\show-build-progress.ps1'
```

This is a small, movable, always-on-top native window. It displays **actions
finished / total actions in the current Ninja pass**, for example `406/5643`
when the actual log says `[406/5643]`. Close the window or press Escape to stop
the display. Closing it does not stop the build. One instance is allowed per
state path.

The counter comes from the log, not an estimate or a timer. It updates locally
every 2 seconds, reads at most 64 KiB of log payload per refresh plus a small encoding
probe, and retains at most 8 KiB of an unfinished line. It supports UTF8 and
Windows PowerShell's UTF16 logs. It runs no SSH, WSL, compiler or task commands,
and it does not modify log/state/source/output files.

During preparation or a new pass's graph scan, `--/--` means a real count is not
available yet. A resumed or lower-concurrency pass can have a smaller total
because prior objects were retained. Counters include finished failed actions;
they are not successful-only counts or release percentages. The small status
line distinguishes reading, paused and stopped/error states. An old log is
labeled quiet, since a long compile or link can be legitimate. The window is
not a substitute for the resource/health check, and it does not compute an ETA.

To use another future build, supply its actual log and worker state paths:

```powershell
& 'B:\BreezerBuild\setup\progress\show-build-progress.ps1' `
  -LogPath 'B:\OtherBuild\build.log' -StatePath 'B:\OtherBuild\state.json'
```

The state must use the existing worker schema, including `pid`, `phase` and
`driverStartedAt`. The log must contain Ninja `[finished/total]` lines and a
`BREEZER_BUILD_PASS` marker at each pass boundary. Do not derive a release total
by summing invocations.

For an optional desktop shortcut, run once on the PC. This creates no login or
scheduled task:

```powershell
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Breezer build progress.lnk'))
$link.TargetPath = (Get-Command powershell.exe).Source
$link.Arguments = '-NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "B:\BreezerBuild\setup\progress\show-build-progress.ps1"'
$link.WorkingDirectory = 'B:\BreezerBuild\setup\progress'
$link.Save()
```

## Copy or verify the feature later

Deploy these two tracked files together into the `progress` folder using the
pinned SFTP connection above:

- `script/windows/BuildProgress.psm1`
- `script/windows/show-build-progress.ps1`

Windows OpenSSH SFTP's absolute drive path is
`/B:/BreezerBuild/setup/progress/`. A bare `B:/...` is not the same SFTP path.
Transferring files does not start the window. Do not overwrite files while a
future window is using them; close that window first.

The focused test is `tests/windows/build-progress.test.ps1`. On the configured
PC its dormant copy can be run without opening a window or reading the live log:

```powershell
& 'B:\BreezerBuild\setup\progress\build-progress.test.ps1' `
  -ModulePath 'B:\BreezerBuild\setup\progress\BuildProgress.psm1' `
  -OutputDirectory 'B:\BreezerBuild\setup\progress'
```

Tests create and remove only a uniquely named fixture folder. `-Snapshot` on
`show-build-progress.ps1` prints one JSON observation without a window. The
test-only `-TestLayout` constructs the native controls and checks that the counter
fits, with no timer or window activation. This is not interactive desktop
acceptance. Visible desktop activation and count-up updates were subsequently verified on
the configured PC. Dragging and other DPI configurations remain separate checks.

The reader uses Microsoft's [shared-file access](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare),
[stateful text decoding](https://learn.microsoft.com/en-us/dotnet/api/system.text.decoder)
and [Windows Forms timer](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.timer).

## Prepare the unattended memory build

Ethan confirmed the PC was on and authorized starting the build on November 3.
The accepted packet was verified on Windows, all 14 supervisor and five cleanup
tests passed in WSL, and preparation migrated the ten pinned resources. The existing
graph, arguments, Ninja journals and compiled output passed before/after
preservation checks. The existing task started at 16:38:21 Sydney time with
`--resume-build-graph`; no clean or graph regeneration was requested.

The latest bounded observation and exact deployed hashes are recorded in
`build/efficiency-20261103/pc-start/handoff.json` in the active worktree. The
30-minute PC monitor was enabled for this build and disabled after completion was
confirmed at 16:56 Sydney time. Its planned 17:12 check was cancelled. The counter
was opened in the logged-in desktop session at Ethan's request and shows
`9/9`, `Compiled`, for the final dynamically reduced Ninja total. Mac and
dual-machine monitors remain disabled.
Use the current bounded health wrapper rather than reading the whole live log:

```sh
python3 -B script/windows/windows-command.py --probe build/efficiency-20261103/pc-start/health.ps1
```

The following preparation procedure is retained for recovery. Do not rerun it
while a build is active.

Generate the checked packet from the current source:

```sh
python3 script/windows/prepare-efficiency-packet.py
```

Using the pinned SFTP connection above, copy the packet's files from
`build/efficiency-20261102/pc-packet` to
`/B:/BreezerBuild/setup/unattended-preparation/`. Verify its `SHA256SUMS` against
the received files. Leave any active compilation alone. When the task is stopped
and Ready, test the supervisor in disposable fixtures before preparing the build:

```powershell
wsl.exe -d BreezerBuild -u breezer --exec env BREEZER_SUPERVISOR_SCRIPT=/mnt/b/BreezerBuild/setup/unattended-preparation/unattended_build.py python3 -B /mnt/b/BreezerBuild/setup/unattended-preparation/unattended_build_test.py
if ($LASTEXITCODE -ne 0) { throw 'Supervisor tests failed; do not prepare or start' }
wsl.exe -d BreezerBuild -u breezer --exec env BREEZER_SUPERVISOR_SCRIPT=/mnt/b/BreezerBuild/setup/unattended-preparation/unattended_build.py python3 -B /mnt/b/BreezerBuild/setup/unattended-preparation/unattended_cleanup_test.py
if ($LASTEXITCODE -ne 0) { throw 'Cleanup fault tests failed; do not prepare or start' }
& 'B:\BreezerBuild\setup\unattended-preparation\prepare-unattended-build.ps1'
```

Preparation requires the audited worker and launcher hashes. It migrates only
`components/breezer_ai/page-context.js`, `translation-content.js`,
`workspace.js`, `workspace-sync.js`, `workspace-sync-model.js`,
`workspace-store.js`, `newtab.js`, `panel.js` and `render-message.js`, and
`chrome/browser/sync/breezer_sync/provider_transport.cc`, plus their
existing source hashes in `combined-1.2.0-inputs.json`, retaining recovery backups.
It validates all ten resources before any writes and preserves already-migrated
resource mtimes on repeated runs. The migration is safe to
rerun after interruption and refuses unknown source or pins. It does not
regenerate the graph or delete objects. It then replaces the task's existing
launcher with the supervised launcher. Neither preparation nor tests start the
browser compilation. Inspect any hash mismatch before proceeding.

After preparation has succeeded and Ethan requests the start, use the existing
`Breezer-PC-Build-Trial` start command earlier in this document. The supervisor
appends to the existing log and retains the worker state path, so the optional progress square
still reads its current-pass counters.

Checkpoint and supervisor files are under the Linux output's
`.breezer-checkpoints` directory:

- `checkpoint-000000010000.json`, then one record per 10,000 observed finished
  actions, plus a final or controlled-stop checkpoint.
- `unattended-state.json` contains the current phase, attempt, counters, recent
  errors, hashes and the exact supervised resume command.

The runner flushes completed work at checkpoints and retries confirmed resource
interruptions at most three times with five minutes between attempts. A failed
compile action still permits independent Ninja work to finish and prevents
success. Deterministic source, dependency, disk or integrity failures produce a
failure report; they are not automatically repaired or ignored. Manual
SIGINT/SIGTERM of the supervisor stops its owned worker and driver without a
retry. Cleanup escalates interrupt to termination and then kill after bounded
grace periods, preserving completed Ninja outputs. Linux orphan adoption must
pass its PC fixture before deployment. Do not use a forceful Windows task kill as a graceful pause.

Detailed evidence and limits are in
[evidence/memory-20261102](evidence/memory-20261102/README.md) and the
[November 3 handoff](evidence/memory-20261103/README.md#authorized-pc-build).
The Windows launch path and WSL fixtures have been exercised. Compilation,
packaging, signature validation, and headless Mac startup/component smoke checks
have passed. Physical interaction, real integrations and whole-browser RAM/CPU
measurements remain separate checks. The current artifact and exact evidence are
in [the package receipt](evidence/memory-20261103/package-verification.json).

## Package the tested native decoder after compilation

The packet also contains the `host-*.mjs` modules and `host-update.json`. These are
for the private Node helper packaged on the Mac after the native output is
retrieved. The ten-resource Chromium migration does not install this helper.

Package only the generated candidate app, before signing and acceptance checks:

```sh
python3 script/package_breezer_ai.py /path/to/generated/Breezer.app --arch arm64 --memory-packet build/efficiency-20261102/pc-packet
python3 script/check_breezer_memory_package.py --app /path/to/generated/Breezer.app --packet build/efficiency-20261102/pc-packet
```

Use `--arch x64` for an Intel candidate. The memory-packet option makes packaging
fail if any bundled host module differs from the tested receipt. The standalone
checker repeats the byte comparison without modifying the app. Existing runtime
checksum, bundle identity and architecture checks still apply. A later regular
source build can pass the same gate with `BREEZER_MEMORY_PACKET` set to the
packet directory. None of these commands have been run against the installed app.

The local helper measurements use synthetic rejected requests and forced garbage
collection. They establish the decoder's transport savings, not whole-browser
RAM, normal AI latency or broad native acceptance. Keep matching browser RAM,
CPU, speed and feature comparisons as separate gates after the candidate exists.
