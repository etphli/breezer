$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ((Get-Volume -DriveLetter B).FileSystemLabel -ne 'BreezerBuild') {
    throw 'Build drive identity changed'
}
$runner = 'B:\BreezerBuild\setup\unattended_build.py'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Unattended runner missing' }
$ErrorActionPreference = 'Continue'
wsl.exe -d BreezerBuild -u breezer --exec python3 /mnt/b/BreezerBuild/setup/unattended_build.py `
    --worker /mnt/b/BreezerBuild/setup/pc-browser-build.py `
    --worker-state /mnt/b/BreezerBuild/logs/pc-browser-build-state.json `
    --output /home/breezer/builds/breezer-1.2.0-pc/src/out/PCMacPerformance `
    >> 'B:\BreezerBuild\logs\pc-browser-build.log' 2>&1
exit $LASTEXITCODE
