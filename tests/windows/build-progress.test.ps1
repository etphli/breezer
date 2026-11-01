#Requires -Version 5.1
param(
    [string]$ModulePath = (Join-Path $PSScriptRoot '..\..\script\windows\BuildProgress.psm1'),
    [string]$OutputDirectory = $env:TEMP
)
$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force
$folder = Join-Path $OutputDirectory ('breezer-counter-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($folder)
$log = Join-Path $folder 'build.log'; $state = Join-Path $folder 'state.json'
$utf8 = [Text.UTF8Encoding]::new($false); $utf16 = [Text.Encoding]::Unicode
$passed = [Collections.Generic.List[string]]::new()
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-State([string]$Phase = 'build-driver-running', [string]$Pass = 'pass1') {
    [IO.File]::WriteAllText($state, (@{phase=$Phase;pid=42;jobs=4;driverStartedAt=$Pass} | ConvertTo-Json), $utf8)
}
function Reader { New-BuildProgressReader -LogPath $log -StatePath $state }
try {
    foreach ($encoding in @($utf8, $utf16, [Text.Encoding]::BigEndianUnicode)) {
        Write-State
        [IO.File]::WriteAllText($log, "BREEZER_BUILD_PASS {}`n[406/5643] CXX real.o`n", $encoding)
        $r = Reader; $s = Read-BuildProgressSnapshot $r
        Assert ($s.Display -eq '406/5643' -and $s.Finished -eq 406) 'Finished/total or encoding is wrong'
        [IO.File]::AppendAllText($log, "[410/5643] CXX next.o`n", $encoding)
        Assert ((Read-BuildProgressSnapshot $r).Display -eq '410/5643') 'Incremental append failed'
    }
    $passed.Add('UTF8/UTF16LE/UTF16BE and incremental finished counts')

    Write-State; [IO.File]::WriteAllText($log, "BREEZER_BUILD_PASS {}`n", $utf16)
    $r = Reader; [void](Read-BuildProgressSnapshot $r)
    $bytes = $utf16.GetBytes("[1/10] CXX unicode.o`n")
    $f = [IO.File]::Open($log, 'Append', 'Write', 'ReadWrite')
    try { $f.Write($bytes, 0, 9) } finally { $f.Dispose() }
    Assert ((Read-BuildProgressSnapshot $r).Display -eq '--/--') 'Partial line fabricated a count'
    $f = [IO.File]::Open($log, 'Append', 'Write', 'ReadWrite')
    try { $f.Write($bytes, 9, $bytes.Length - 9) } finally { $f.Dispose() }
    Assert ((Read-BuildProgressSnapshot $r).Display -eq '1/10') 'Split UTF16code unit was lost'
    $passed.Add('Partial writes and split Unicode code units')

    [IO.File]::AppendAllText($log, "BREEZER_BUILD_PASS {}`n", $utf16)
    Assert ((Read-BuildProgressSnapshot $r).Display -eq '--/--') 'New pass kept stale totals'
    [IO.File]::AppendAllText($log, "[2/8] CXX after-reduction.o`n", $utf16)
    Assert ((Read-BuildProgressSnapshot $r).Display -eq '2/8') 'Pass counters were summed'
    Write-State 'build-driver-running' 'pass2'
    [IO.File]::WriteAllText($log, "BREEZER_BUILD_PASS {}`n", $utf8)
    Assert ((Read-BuildProgressSnapshot $r).Display -eq '--/--') 'Driver reset kept old progress'
    $passed.Add('Pass boundaries, driver changes and truncation')

    [IO.File]::WriteAllText($log, "BREEZER_BUILD_PASS {}`n[2/8] CXX a.o`nFAILED: bad.o`n", $utf8)
    $r = Reader; $s = Read-BuildProgressSnapshot $r
    Assert ($s.Warning -and $s.Status -eq 'Action failed' -and $s.Display -eq '2/8') 'Failure was hidden'
    Write-State 'blocked' 'pass2'; Assert ((Read-BuildProgressSnapshot $r).Status -eq 'Stopped: error') 'Terminal error mislabeled'
    Write-State 'resource-limited' 'pass2'; Assert ((Read-BuildProgressSnapshot $r).Status -eq 'Paused') 'Pause mislabeled'
    Write-State 'built-unverified-on-mac' 'pass2'; Assert ((Read-BuildProgressSnapshot $r).Status -eq 'Compiled') 'Compilation state lost'
    $passed.Add('Failures and paused/compiled state are separate from counter')

    [IO.File]::WriteAllText($state, '{"pid":43,"phase":"verifying-transferred-inputs"}', $utf8)
    Assert ((Read-BuildProgressSnapshot $r).Status -eq 'Preparing') 'Preparation without driver fields failed'
    [IO.File]::WriteAllText($state, '{partial', $utf8)
    Assert ((Read-BuildProgressSnapshot $r).Display -eq '--/--') 'Malformed state fabricated data'
    [IO.File]::Delete($state)
    Assert ((Read-BuildProgressSnapshot $r).Status -eq 'Status unavailable') 'Missing state failed'
    $passed.Add('Preparation, missing files and partial JSON')

    Write-State
    [IO.File]::WriteAllText($log, (('padding' + "`n") * 20000) + "[999/1000] CXX last.o`n", $utf8)
    $r = Reader; $s = Read-BuildProgressSnapshot $r
    Assert ($s.Display -eq '999/1000' -and $r.LastBytesRead -le 65536) 'Initial tail read is not bounded'
    [IO.File]::AppendAllText($log, (('more' + "`n") * 20000) + "[1000/1000] CXX last.o`n", $utf8)
    $s = Read-BuildProgressSnapshot $r
    Assert ($s.Display -eq '1000/1000' -and $r.LastBytesRead -le 65536 -and $r.Carry.Length -le 8192) 'Backlog read is not bounded'
    [IO.File]::SetLastWriteTimeUtc($log, [datetime]::UtcNow.AddMinutes(-5))
    Assert ((Read-BuildProgressSnapshot $r).Status -eq 'No recent log') 'Quiet log was presented as fresh'
    $passed.Add('Bounded initial/backlog reads and stale-log label')

    [pscustomobject]@{Passed=$true; Cases=$passed.ToArray(); FixtureOnly=$true; BuildTouched=$false} | ConvertTo-Json
} finally {
    # Only this test's newly created temporary fixture directory.
    [IO.Directory]::Delete($folder, $true)
}
