# Run from the staged packet on the configured PC. This does not start a build.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ((Get-Volume -DriveLetter B).FileSystemLabel -ne 'BreezerBuild') { throw 'Build drive identity changed' }
$task = Get-ScheduledTask -TaskName 'Breezer-PC-Build-Trial'
if ([string]$task.State -ne 'Ready') { throw 'Build task must be stopped and Ready before preparation' }
$setup = 'B:\BreezerBuild\setup'
$worker = Join-Path $setup 'pc-browser-build.py'
# Match the worker audited with this runner. It owns pinned inputs and paging guards.
if ((Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash.ToLowerInvariant() -ne '9a88cce3946fb577ce0466d708c077551badf1a2b869cc5de14aa7c2b84d9207') {
    throw 'Worker changed since review; inspect it before deploying the supervisor'
}
$launcher = Join-Path $setup 'continue-pc-browser-compile.ps1'
$current = (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant()
$replacement = Join-Path $PSScriptRoot 'continue-pc-browser-unattended.ps1'
$next = (Get-FileHash -LiteralPath $replacement -Algorithm SHA256).Hash.ToLowerInvariant()
if ($current -ne '3a317d52748489be6c4ecf7793dd4c6da256eeb1eccceec8fd30e84d99cc89c3' -and $current -ne $next) {
    throw 'Launcher changed since review; preserve it and inspect before replacing'
}
if ($current -ne $next) {
    $backup = $launcher + '.before-unattended.bak'
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $launcher -Destination $backup }
}
if ($PSScriptRoot -ne 'B:\BreezerBuild\setup\unattended-preparation') { throw 'Stage this packet under B:\BreezerBuild\setup\unattended-preparation first' }
& wsl.exe -d BreezerBuild -u breezer --exec python3 /mnt/b/BreezerBuild/setup/unattended-preparation/apply-memory-update.py `
    --source /home/breezer/builds/breezer-1.2.0-pc/src `
    --plan /mnt/b/BreezerBuild/setup/combined-1.2.0-inputs.json
if ($LASTEXITCODE -ne 0) { throw 'Memory resource migration failed; build remains stopped' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'unattended_build.py') -Destination (Join-Path $setup 'unattended_build.py') -Force
Copy-Item -LiteralPath $replacement -Destination ($launcher + '.tmp') -Force
Move-Item -LiteralPath ($launcher + '.tmp') -Destination $launcher -Force
if ((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant() -ne $next) { throw 'Launcher verification failed' }
Write-Output 'Unattended runner prepared. Build remains stopped; no start time registered.'
