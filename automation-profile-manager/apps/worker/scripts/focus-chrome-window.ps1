param(
  [Parameter(Mandatory = $true)]
  [int]$RootPid,
  [switch]$NoMaximize,
  [switch]$NoAlt,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not ("WinFocusHelper" -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinFocusHelper {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@
}

$parentOf = @{}
$chrome = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue)
foreach ($p in $chrome) {
  $parentOf[[int]$p.ProcessId] = [int]$p.ParentProcessId
}

function Test-UnderRoot([int]$id, [int]$root) {
  $guard = 0
  while ($id -and $guard -lt 32) {
    if ($id -eq $root) { return $true }
    if (-not $parentOf.ContainsKey($id)) { return $false }
    $id = [int]$parentOf[$id]
    $guard++
  }
  return $false
}

$allow = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$allow.Add($RootPid)
foreach ($p in $chrome) {
  $cid = [int]$p.ProcessId
  if (Test-UnderRoot $cid $RootPid) { [void]$allow.Add($cid) }
}

$best = [IntPtr]::Zero
$bestArea = -1
$bestVisible = $false

$callback = [WinFocusHelper+EnumWindowsProc]{
  param([IntPtr]$hwnd, [IntPtr]$lParam)
  $procId = 0
  [void][WinFocusHelper]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  if (-not $allow.Contains($procId)) { return $true }

  $len = [WinFocusHelper]::GetWindowTextLength($hwnd)
  if ($len -le 0) { return $true }

  $rect = New-Object WinFocusHelper+RECT
  if (-not [WinFocusHelper]::GetWindowRect($hwnd, [ref]$rect)) { return $true }
  $area = [Math]::Abs(($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top))
  if ($area -lt 20000) { return $true }

  $vis = [WinFocusHelper]::IsWindowVisible($hwnd)
  $better = $false
  if ($script:best -eq [IntPtr]::Zero) { $better = $true }
  elseif ($vis -and -not $script:bestVisible) { $better = $true }
  elseif ($vis -eq $script:bestVisible -and $area -gt $script:bestArea) { $better = $true }

  if ($better) {
    $script:bestArea = $area
    $script:best = $hwnd
    $script:bestVisible = $vis
  }
  return $true
}

$script:best = [IntPtr]::Zero
$script:bestArea = -1
$script:bestVisible = $false
[void][WinFocusHelper]::EnumWindows($callback, [IntPtr]::Zero)

if ($script:best -eq [IntPtr]::Zero) {
  Write-Output "no-window pid-tree=$RootPid"
  exit 1
}

$foreNow = [WinFocusHelper]::GetForegroundWindow()
if (-not $Force -and $foreNow -eq $script:best) {
  Write-Output "already-foreground hwnd=$($script:best)"
  exit 0
}

if ([WinFocusHelper]::IsIconic($script:best)) {
  [void][WinFocusHelper]::ShowWindow($script:best, 9) # SW_RESTORE
}
# Luôn SHOW — Chrome hay bị IsWindowVisible=false dù vẫn còn hwnd (nhìn như "đóng")
[void][WinFocusHelper]::ShowWindow($script:best, 9) # SW_RESTORE
[void][WinFocusHelper]::ShowWindow($script:best, 5) # SW_SHOW
if (-not $NoMaximize) {
  [void][WinFocusHelper]::ShowWindow($script:best, 3) # SW_MAXIMIZE
}

[void][WinFocusHelper]::AllowSetForegroundWindow(-1)
if (-not $NoAlt) {
  [WinFocusHelper]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero) | Out-Null
  [WinFocusHelper]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero) | Out-Null
}

[void][WinFocusHelper]::BringWindowToTop($script:best)
[void][WinFocusHelper]::SwitchToThisWindow($script:best, $true)
[void][WinFocusHelper]::SetForegroundWindow($script:best)

Start-Sleep -Milliseconds 120
$foreAfter = [WinFocusHelper]::GetForegroundWindow()
$ok = ($foreAfter -eq $script:best)
Write-Output "focused pid-tree=$RootPid hwnd=$($script:best) ok=$ok noMax=$NoMaximize noAlt=$NoAlt area=$($script:bestArea)"
