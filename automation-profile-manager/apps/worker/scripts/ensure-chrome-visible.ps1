param(
  [Parameter(Mandatory = $true)]
  [int]$RootPid
)

$ErrorActionPreference = "Stop"

if (-not ("ChromeVisHelper" -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ChromeVisHelper {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
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

$script:best = [IntPtr]::Zero
$script:bestArea = -1
$script:bestVisible = $false

$callback = [ChromeVisHelper+EnumWindowsProc]{
  param([IntPtr]$hwnd, [IntPtr]$lParam)
  $procId = 0
  [void][ChromeVisHelper]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  if (-not $allow.Contains($procId)) { return $true }
  if ([ChromeVisHelper]::GetWindowTextLength($hwnd) -le 0) { return $true }
  $rect = New-Object ChromeVisHelper+RECT
  if (-not [ChromeVisHelper]::GetWindowRect($hwnd, [ref]$rect)) { return $true }
  $area = [Math]::Abs(($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top))
  if ($area -lt 20000) { return $true }
  $vis = [ChromeVisHelper]::IsWindowVisible($hwnd)
  $better = $false
  if ($script:best -eq [IntPtr]::Zero) { $better = $true }
  elseif ($vis -and -not $script:bestVisible) { $better = $true }
  elseif ($vis -eq $script:bestVisible -and $area -gt $script:bestArea) { $better = $true }
  if ($better) {
    $script:best = $hwnd
    $script:bestArea = $area
    $script:bestVisible = $vis
  }
  return $true
}

[void][ChromeVisHelper]::EnumWindows($callback, [IntPtr]::Zero)

if ($script:best -eq [IntPtr]::Zero) {
  Write-Output "no-window pid-tree=$RootPid"
  exit 2
}

$wasHidden = -not $script:bestVisible
$wasIconic = [ChromeVisHelper]::IsIconic($script:best)

if ($wasHidden -or $wasIconic) {
  [void][ChromeVisHelper]::ShowWindow($script:best, 9)  # SW_RESTORE
  [void][ChromeVisHelper]::ShowWindow($script:best, 5)  # SW_SHOW
  [void][ChromeVisHelper]::ShowWindowAsync($script:best, 3) # SW_MAXIMIZE
  # SWP_NOSIZE|SWP_NOMOVE|SWP_SHOWWINDOW
  [void][ChromeVisHelper]::SetWindowPos($script:best, [IntPtr]::Zero, 0, 0, 0, 0, 0x0043)
  [void][ChromeVisHelper]::BringWindowToTop($script:best)
  [void][ChromeVisHelper]::SetForegroundWindow($script:best)
}

$nowVis = [ChromeVisHelper]::IsWindowVisible($script:best)
Write-Output "hwnd=$($script:best) wasHidden=$wasHidden wasIconic=$wasIconic nowVis=$nowVis area=$($script:bestArea)"
exit 0
