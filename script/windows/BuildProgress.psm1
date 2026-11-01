Set-StrictMode -Version Latest

function New-BuildProgressReader {
    param([string]$LogPath, [string]$StatePath)
    return @{
        LogPath = $LogPath; StatePath = $StatePath; Key = ''; Identity = 0L
        Offset = -1L; Decoder = $null; CodePage = 65001; Carry = ''; DiscardLine = $false
        Finished = $null; Total = $null; FailureSeen = $false
        Bytes = [byte[]]::new(65536); Chars = [char[]]::new(65538)
        LastBytesRead = 0
    }
}

function Reset-BuildProgressCounter($Reader) {
    $Reader.Finished = $null; $Reader.Total = $null; $Reader.FailureSeen = $false
    $Reader.Carry = ''; $Reader.DiscardLine = $false
}

function Read-BuildProgressLines($Reader, [string]$Text) {
    $parts = [regex]::Split(($Reader.Carry + $Text), '\r\n|\r|\n')
    $Reader.Carry = $parts[-1]
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        if ($Reader.DiscardLine) { $Reader.DiscardLine = $false; continue }
        $line = $parts[$i]
        if ($line.StartsWith('BREEZER_BUILD_PASS ')) {
            $Reader.Finished = $null; $Reader.Total = $null; $Reader.FailureSeen = $false
        } elseif ($line -match '^\[(\d{1,10})/(\d{1,10})\]') {
            $finished = [long]$Matches[1]; $total = [long]$Matches[2]
            if ($total -gt 0 -and $finished -le $total) {
                $Reader.Finished = $finished; $Reader.Total = $total
            }
        } elseif ($line.StartsWith('FAILED:')) { $Reader.FailureSeen = $true }
    }
    # Discard oversized non-status lines rather than retaining a growing log.
    if ($Reader.Carry.Length -gt 8192) {
        $Reader.Carry = ''; $Reader.DiscardLine = $true
    }
}

function Read-BuildProgressSnapshot {
    param([System.Collections.IDictionary]$Reader)
    $result = [ordered]@{
        Display = '--/--'; Remaining = $null; Total = $null; Finished = $null
        Status = 'Waiting'; Phase = ''; Detail = ''; Jobs = $null
        Warning = $false; LogAgeSeconds = $null; BytesRead = 0
    }
    $Reader.LastBytesRead = 0
    try {
        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $file = [IO.File]::Open($Reader.StatePath, 'Open', 'Read', $share)
        try {
            if ($file.Length -gt 65536) { throw 'State file exceeds64KiB' }
            $stream = [IO.StreamReader]::new($file, [Text.Encoding]::UTF8, $true)
            try { $state = $stream.ReadToEnd() | ConvertFrom-Json }
            finally { $stream.Dispose() }
        } finally { $file.Dispose() }
        $result.Phase = [string]$state.phase
        $jobsProperty = $state.PSObject.Properties['jobs']
        if ($null -ne $jobsProperty) { $result.Jobs = $jobsProperty.Value }
        $driver = ''
        $driverProperty = $state.PSObject.Properties['driverStartedAt']
        if ($null -ne $driverProperty) { $driver = $driverProperty.Value }
        $key = '{0}/{1}' -f $state.pid, $driver
        if ($key -ne $Reader.Key) {
            Reset-BuildProgressCounter $Reader
            $Reader.Offset = -1L; $Reader.Key = $key
        }
        $allowed = @('build-driver-starting', 'build-driver-running',
            'resource-pressure-reducing-jobs', 'resource-limited', 'blocked',
            'failed', 'built-unverified-on-mac')
        if ($result.Phase -notin $allowed) {
            Reset-BuildProgressCounter $Reader; $Reader.Offset = -1L
            $result.Status = 'Preparing'
            return [pscustomobject]$result
        }
        $file = [IO.File]::Open($Reader.LogPath, 'Open', 'Read', $share)
        try {
            $identity = [IO.File]::GetCreationTimeUtc($Reader.LogPath).Ticks
            $reset = $Reader.Offset -lt 0 -or $file.Length -lt $Reader.Offset -or $identity -ne $Reader.Identity
            if ($reset) {
                Reset-BuildProgressCounter $Reader
                $Reader.Identity = $identity; $Reader.Offset = 0L
                if ($file.Length -lt 3) {
                    $Reader.Offset = -1L; $result.Status = 'Reading graph'
                    return [pscustomobject]$result
                }
                $head = [byte[]]::new(3); [void]$file.Read($head, 0, 3)
                $encoding = [Text.Encoding]::UTF8
                if ($head[0] -eq 255 -and $head[1] -eq 254) { $encoding = [Text.Encoding]::Unicode }
                elseif ($head[0] -eq 254 -and $head[1] -eq 255) { $encoding = [Text.Encoding]::BigEndianUnicode }
                $Reader.CodePage = $encoding.CodePage
                $Reader.Decoder = $encoding.GetDecoder()
            }
            if ($file.Length - $Reader.Offset -gt $Reader.Bytes.Length) {
                $Reader.Offset = $file.Length - $Reader.Bytes.Length
                # UTF16seek positions must land on a code-unit boundary.
                if ($Reader.CodePage -in @(1200, 1201)) {
                    $Reader.Offset -= $Reader.Offset % 2
                }
                $Reader.Decoder.Reset(); $Reader.Carry = ''; $Reader.DiscardLine = $true
            }
            [void]$file.Seek($Reader.Offset, 'Begin')
            $count = $file.Read($Reader.Bytes, 0, $Reader.Bytes.Length)
            $Reader.Offset += $count; $Reader.LastBytesRead = $count
            if ($count -gt 0) {
                $chars = $Reader.Decoder.GetChars($Reader.Bytes, 0, $count, $Reader.Chars, 0, $false)
                Read-BuildProgressLines $Reader ([string]::new($Reader.Chars, 0, $chars))
            }
        } finally { $file.Dispose() }
        $result.LogAgeSeconds = [math]::Max(0, ([datetime]::UtcNow - [IO.File]::GetLastWriteTimeUtc($Reader.LogPath)).TotalSeconds)
        $result.Status = 'Reading graph'
        if ($null -ne $Reader.Total) {
            $result.Finished = $Reader.Finished; $result.Total = $Reader.Total
            $result.Remaining = $Reader.Total - $Reader.Finished
            $result.Display = '{0}/{1}' -f $result.Finished, $result.Total
            $result.Status = 'Current pass'
        }
        if ($Reader.FailureSeen) { $result.Status = 'Action failed'; $result.Warning = $true }
        switch ($result.Phase) {
            'resource-pressure-reducing-jobs' { $result.Status = 'Reducing jobs'; $result.Warning = $true }
            'resource-limited' { $result.Status = 'Paused'; $result.Warning = $true }
            'blocked' { $result.Status = 'Stopped: error'; $result.Warning = $true }
            'failed' { $result.Status = 'Stopped: error'; $result.Warning = $true }
            'built-unverified-on-mac' { $result.Status = 'Compiled' }
        }
        if ($result.Status -eq 'Current pass' -and $result.LogAgeSeconds -gt 120) { $result.Status = 'No recent log' }
        $result.Detail = 'Current-pass actions only. Finished actions can include failures; this is not release completion.'
        $result.BytesRead = $Reader.LastBytesRead
    } catch {
        $result.Display = '--/--'; $result.Remaining = $null; $result.Total = $null; $result.Finished = $null
        $result.Status = 'Status unavailable'; $result.Warning = $true
        $result.Detail = $_.Exception.Message
    }
    return [pscustomobject]$result
}

Export-ModuleMember -Function New-BuildProgressReader, Read-BuildProgressSnapshot
