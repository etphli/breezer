#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$LogPath = 'B:\BreezerBuild\logs\pc-browser-build.log',
    [string]$StatePath = 'B:\BreezerBuild\logs\pc-browser-build-state.json',
    [ValidateRange(1000, 60000)][int]$RefreshMs = 2000,
    [switch]$Snapshot,
    [switch]$TestLayout,
    [string]$ActivationReceiptPath
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BuildProgress.psm1') -Force
$reader = New-BuildProgressReader -LogPath $LogPath -StatePath $StatePath
if ($Snapshot) { Read-BuildProgressSnapshot $reader | ConvertTo-Json -Compress; return }

# A desktop-only view. It never starts WSL, a build, a task or a remote command.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$hash = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($StatePath).ToUpperInvariant()))).Replace('-', '') }
finally { $hash.Dispose() }
$mutex = [Threading.Mutex]::new($false, ('Local\BreezerBuildProgress-' + $key))
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { Write-Output 'This build progress square is already open.'; return }
    $form = [Windows.Forms.Form]::new()
    $form.Text = 'Breezer build'; $form.Size = [Drawing.Size]::new(184, 184)
    $form.FormBorderStyle = 'FixedToolWindow'; $form.MaximizeBox = $false
    $form.TopMost = $true; $form.StartPosition = 'Manual'; $form.AutoScaleMode = 'Dpi'
    $form.BackColor = [Drawing.ColorTranslator]::FromHtml('#F5F7FA')
    $area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Location = [Drawing.Point]::new(($area.Right - $form.Width - 20), ($area.Bottom - $form.Height - 20))
    $grid = [Windows.Forms.TableLayoutPanel]::new(); $grid.Dock = 'Fill'
    $grid.ColumnCount = 1; $grid.RowCount = 3
    $grid.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent', 30)) | Out-Null
    $grid.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent', 40)) | Out-Null
    $grid.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent', 30)) | Out-Null
    $labels = @()
    foreach ($text in @('Actions finished', '--/--', 'Waiting')) {
        $label = [Windows.Forms.Label]::new(); $label.Text = $text
        $label.Dock = 'Fill'; $label.TextAlign = 'MiddleCenter'
        $label.ForeColor = [Drawing.ColorTranslator]::FromHtml('#526276')
        $label.Font = [Drawing.Font]::new('Segoe UI', 9)
        $grid.Controls.Add($label); $labels += $label
    }
    $labels[1].Font.Dispose()
    $labels[1].Font = [Drawing.Font]::new('Consolas', 17, [Drawing.FontStyle]::Bold)
    $labels[1].ForeColor = [Drawing.ColorTranslator]::FromHtml('#182536')
    $labels[1].AccessibleName = 'Actions finished out of current-pass total'
    $form.Controls.Add($grid)
    $tip = [Windows.Forms.ToolTip]::new()
    $timer = [Windows.Forms.Timer]::new(); $timer.Interval = $RefreshMs
    $refresh = {
        $s = Read-BuildProgressSnapshot $reader
        $labels[1].Text = $s.Display; $labels[2].Text = $s.Status
        $labels[2].ForeColor = [Drawing.ColorTranslator]::FromHtml($(if ($s.Warning) { '#8A4B08' } else { '#526276' }))
        $details = $s.Detail
        if ($null -ne $s.Finished) { $details = "$($s.Finished) finished; $($s.Remaining) left of $($s.Total). $details" }
        if ($null -ne $s.LogAgeSeconds) { $details += " Last log write $([int]$s.LogAgeSeconds)s ago." }
        foreach ($label in $labels) { $tip.SetToolTip($label, $details) }
    }
    $timer.Add_Tick($refresh)
    $form.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $form.Close() } }); $form.KeyPreview = $true
    if ($ActivationReceiptPath) {
        $form.Add_Shown({
            [IO.File]::WriteAllText($ActivationReceiptPath, (@{
                shownAt = [datetime]::UtcNow.ToString('o'); visible = $form.Visible
                pid = $PID; title = $form.Text; counter = $labels[1].Text
                left = $form.Left; top = $form.Top; width = $form.Width; height = $form.Height
                sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
            } | ConvertTo-Json))
        })
    }
    $form.Add_FormClosed({ $timer.Stop() })
    try {
        & $refresh
        if ($TestLayout) {
            # Construct the actual controls, but do not open a window or timer.
            $measured = [Windows.Forms.TextRenderer]::MeasureText($labels[1].Text, $labels[1].Font)
            if ($form.Visible -or $timer.Enabled) { throw 'Layout test activated the widget' }
            if ($measured.Width -gt $form.ClientSize.Width) { throw 'Counter does not fit the window' }
            [pscustomobject]@{
                Counter = $labels[1].Text; Status = $labels[2].Text
                CounterWidth = $measured.Width; ClientWidth = $form.ClientSize.Width
                ControlCount = $grid.Controls.Count; Visible = $form.Visible
                TimerEnabled = $timer.Enabled; TopMost = $form.TopMost
            } | ConvertTo-Json -Compress
        } else {
            $timer.Start(); [Windows.Forms.Application]::Run($form)
        }
    } finally {
        $timer.Dispose(); $tip.Dispose()
        foreach ($label in $labels) { $label.Font.Dispose() }
        $form.Dispose()
    }
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
