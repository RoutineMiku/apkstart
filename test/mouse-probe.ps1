# Probe: does the emulator map mouse side buttons (XBUTTON1/2) to BACK?
param([int]$Button = 1)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class M {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$script:hwnd = [IntPtr]::Zero
$cb = [M+EnumProc]{
  param($h, $p)
  $pp = 0
  [void][M]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match 'qemu' -and [M]::IsWindowVisible($h)) { $script:hwnd = $h }
  return $true
}
[void][M]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:hwnd -eq [IntPtr]::Zero) { Write-Output 'ERR=no-window'; exit 1 }
[void][M]::ShowWindow($script:hwnd, 9)
[void][M]::SetForegroundWindow($script:hwnd)
Start-Sleep -Milliseconds 500
$r = New-Object M+RECT
[void][M]::GetWindowRect($script:hwnd, [ref]$r)
[M]::SetCursorPos([int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2))
Start-Sleep -Milliseconds 300
$XDOWN = 0x0080; $XUP = 0x0100
[M]::mouse_event($XDOWN, 0, 0, [uint32]$Button, [IntPtr]::Zero)
[M]::mouse_event($XUP, 0, 0, [uint32]$Button, [IntPtr]::Zero)
Write-Output ("SENT xbutton {0}" -f $Button)
Start-Sleep -Milliseconds 1200
