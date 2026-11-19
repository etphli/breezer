param(
    [Parameter(Mandatory = $true)][int]$BrowserProcessId,
    [Parameter(Mandatory = $true)][string]$Fixture
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ImportPickerWindow {
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);
}
'@

function Test-BrowserOwnership([IntPtr]$Window) {
    # Chromium can show the picker in a utility process owned by the browser window.
    while ($Window -ne [IntPtr]::Zero) {
        $ownerProcess = 0
        [void][ImportPickerWindow]::GetWindowThreadProcessId($Window, [ref]$ownerProcess)
        if ($ownerProcess -eq $BrowserProcessId) { return $true }
        $Window = [ImportPickerWindow]::GetWindow($Window, 4) # GW_OWNER
    }
    return $false
}

$root = [Windows.Automation.AutomationElement]::RootElement
$dialogClass = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
$filenameCombo = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::AutomationIdProperty, '1148')
$editType = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)
$openId = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::AutomationIdProperty, '1')
$deadline = [DateTime]::UtcNow.AddSeconds(20)

while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($dialog in $root.FindAll([Windows.Automation.TreeScope]::Children, $dialogClass)) {
        if (-not (Test-BrowserOwnership ([IntPtr]$dialog.Current.NativeWindowHandle))) { continue }
        $combo = $dialog.FindFirst([Windows.Automation.TreeScope]::Descendants, $filenameCombo)
        $open = $dialog.FindFirst([Windows.Automation.TreeScope]::Descendants, $openId)
        if ($null -eq $combo -or $null -eq $open) { continue }
        $edit = $combo
        if ($combo.Current.ControlType -ne [Windows.Automation.ControlType]::Edit) {
            $edit = $combo.FindFirst([Windows.Automation.TreeScope]::Descendants, $editType)
        }
        if ($null -eq $edit) { continue }
        $edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Fixture)
        $open.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
        exit 0
    }
    Start-Sleep -Milliseconds 200
}

throw 'Could not find the file picker for this Breezer instance. Run the smoke test on an unlocked Windows desktop.'
