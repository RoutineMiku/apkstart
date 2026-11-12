# ApkStart window controller (ASCII-only source; Chinese text comes from UTF-8 JSON).
# Pure Win32 P/Invoke, no compiled binary, no third party dependency.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File windowctl.ps1 params.json
param([string]$JsonPath)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::ASCII

if (-not (Test-Path $JsonPath)) { Write-Output 'OK=0'; Write-Output 'ERR=no-json'; exit 0 }
$j = [System.IO.File]::ReadAllText($JsonPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

$src = @'
using System;
using System.Runtime.InteropServices;
public class ApkWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string s);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int idx, int val);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadImage(IntPtr inst, string file, uint type, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);
}
'@
Add-Type -TypeDefinition $src

function Find-Win([int]$procId) {
  # No pid (reused runtime started by another process): scan emulator/qemu windows.
  if ($procId -le 0) {
    $cand = Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.ProcessName -match 'emulator|qemu' }
    foreach ($c in $cand) { return $c.MainWindowHandle }
    return [IntPtr]::Zero
  }
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($null -ne $p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { return $p.MainWindowHandle }
  # Qt builds usually expose the HWND on the qemu child process.
  $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue
  foreach ($k in $kids) {
    $q = Get-Process -Id $k.ProcessId -ErrorAction SilentlyContinue
    if ($null -ne $q -and $q.MainWindowHandle -ne [IntPtr]::Zero) { return $q.MainWindowHandle }
  }
  return [IntPtr]::Zero
}

$action = [string]$j.action
if ($action -eq 'refresh') {
  # Tell Explorer a shortcut / icon changed, otherwise the new desktop icon may
  # not appear until the user presses F5 (reported as "shortcut missing").
  [void][ApkWin]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
  Write-Output 'OK=1'
  exit 0
}

$hwnd = Find-Win ([int]$j.pid)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'OK=0'; Write-Output 'ERR=no-window'; exit 0 }
Write-Output ("HWND=" + $hwnd.ToInt64())

if ($action -eq 'get') {
  $r = New-Object ApkWin+RECT
  [void][ApkWin]::GetWindowRect($hwnd, [ref]$r)
  Write-Output ("X=" + $r.Left)
  Write-Output ("Y=" + $r.Top)
  Write-Output ("W=" + ($r.Right - $r.Left))
  Write-Output ("H=" + ($r.Bottom - $r.Top))
  Write-Output ("MAX=" + $(if ([ApkWin]::IsZoomed($hwnd)) { 1 } else { 0 }))
  Write-Output 'OK=1'
  exit 0
}

if ($j.title) { [void][ApkWin]::SetWindowText($hwnd, [string]$j.title) }

if ($j.icon) {
  try {
    $hicon = [ApkWin]::LoadImage([IntPtr]::Zero, [string]$j.icon, 1, 0, 0, 0x10)
    if ($hicon -ne [IntPtr]::Zero) {
      [void][ApkWin]::SendMessage($hwnd, 0x0080, [IntPtr]0, $hicon)
      [void][ApkWin]::SendMessage($hwnd, 0x0080, [IntPtr]1, $hicon)
    }
  } catch { }
}

$style = [ApkWin]::GetWindowLong($hwnd, -16)
$SWP = 0x0060   # SWP_SHOWWINDOW | SWP_FRAMECHANGED (apply style change immediately)
if ($action -eq 'fullscreen') {
  # The emulator window keeps its LCD aspect ratio, so SW_MAXIMIZE only gives a
  # narrow window stuck to the left. The caller computes a "full height, centered"
  # rect and we just strip the frame and apply it.
  $new = $style -band (-bnot 0x00C40000)   # drop caption / resizable frame
  [void][ApkWin]::SetWindowLong($hwnd, -16, $new)
  [void][ApkWin]::ShowWindow($hwnd, 9)      # SW_RESTORE first
  if ($j.bounds) {
    $b = $j.bounds
    [void][ApkWin]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$b.x, [int]$b.y, [int]$b.w, [int]$b.h, $SWP)
  } else {
    [void][ApkWin]::ShowWindow($hwnd, 3)    # SW_MAXIMIZE
  }
} elseif ($action -eq 'window') {
  $want = 0x00C40000 -bor 0x00080000       # caption + thick frame + system menu
  [void][ApkWin]::SetWindowLong($hwnd, -16, $style -bor $want)
  [void][ApkWin]::ShowWindow($hwnd, 9)      # SW_RESTORE
  if ($j.bounds) {
    $b = $j.bounds
    [void][ApkWin]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$b.x, [int]$b.y, [int]$b.w, [int]$b.h, $SWP)
  }
} elseif ($action -eq 'focus') {
  [void][ApkWin]::ShowWindow($hwnd, 9)
}

[void][ApkWin]::SetForegroundWindow($hwnd)
Write-Output 'OK=1'
