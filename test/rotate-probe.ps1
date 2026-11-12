# Probe: rotate the emulator with Ctrl+Left / Ctrl+Right (Qt UI shortcut) and observe.
param([switch]$Right)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class K {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$script:hwnd = [IntPtr]::Zero
$cb = [K+EnumProc]{
  param($h, $p)
  $pp = 0
  [void][K]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match 'qemu' -and [K]::IsWindowVisible($h)) { $script:hwnd = $h }
  return $true
}
[void][K]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:hwnd -eq [IntPtr]::Zero) { Write-Output 'ERR=no-window'; exit 1 }
[void][K]::ShowWindow($script:hwnd, 9)
[void][K]::SetForegroundWindow($script:hwnd)
Start-Sleep -Milliseconds 400
$r0 = New-Object K+RECT
[void][K]::GetWindowRect($script:hwnd, [ref]$r0)
Write-Output ("BEFORE {0}x{1}" -f ($r0.R - $r0.L), ($r0.B - $r0.T))
$VK_CONTROL = 0x11; $VK_LEFT = 0x25; $VK_RIGHT = 0x27
$vk = if ($Right) { $VK_RIGHT } else { $VK_LEFT }
[K]::keybd_event($VK_CONTROL, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[K]::keybd_event([byte]$vk, 0, 2, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event($VK_CONTROL, 0, 2, [IntPtr]::Zero)
Start-Sleep -Milliseconds 1500
$r1 = New-Object K+RECT
[void][K]::GetWindowRect($script:hwnd, [ref]$r1)
Write-Output ("AFTER {0}x{1}" -f ($r1.R - $r1.L), ($r1.B - $r1.T))
