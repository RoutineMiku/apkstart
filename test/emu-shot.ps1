# Resize the running emulator window and screenshot it (probe helper).
param([int]$W = 900, [int]$H = 1650, [string]$Out = "emu-shot.png")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class W2 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$script:hwnd = [IntPtr]::Zero
$cb = [W2+EnumProc]{
  param($h, $p)
  $pp = 0
  [void][W2]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match 'qemu' -and [W2]::IsWindowVisible($h)) { $script:hwnd = $h }
  return $true
}
[void][W2]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:hwnd -eq [IntPtr]::Zero) { Write-Output 'ERR=no-window'; exit 1 }
[void][W2]::ShowWindow($script:hwnd, 9)
[void][W2]::SetWindowPos($script:hwnd, [IntPtr]::Zero, 30, 20, $W, $H, 0x0040)
[void][W2]::SetForegroundWindow($script:hwnd)
Start-Sleep -Milliseconds 1800
$r = New-Object W2+RECT
[void][W2]::GetWindowRect($script:hwnd, [ref]$r)
$w = $r.R - $r.L; $h2 = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h2
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $h2))
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("SHOT {0} {1}x{2} at {3},{4}" -f $Out, $w, $h2, $r.L, $r.T)
