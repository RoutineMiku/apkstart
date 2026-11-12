# Force a full repaint of the emulator window (minimize -> restore) then screenshot it.
param([int]$W = 540, [int]$H = 983, [string]$Out = "emu-clean.png")
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class R2 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr h, IntPtr r, bool erase);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$script:main = [IntPtr]::Zero
$script:other = New-Object System.Collections.ArrayList
$cb = [R2+EnumProc]{
  param($h, $p)
  $pp = 0
  [void][R2]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -notmatch 'qemu') { return $true }
  if (-not [R2]::IsWindowVisible($h)) { return $true }
  $r = New-Object R2+RECT
  [void][R2]::GetWindowRect($h, [ref]$r)
  if (($r.R - $r.L) -gt 400) { $script:main = $h } else { [void]$script:other.Add($h) }
  return $true
}
[void][R2]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:main -eq [IntPtr]::Zero) { Write-Output 'ERR=no-main'; exit 1 }
foreach ($h in $script:other) { [void][R2]::ShowWindow($h, 0); Write-Output "hid small window $h" }

[void][R2]::ShowWindow($script:main, 9)
[void][R2]::SetWindowPos($script:main, [IntPtr]::Zero, 40, 24, $W, $H, 0x0040)
[void][R2]::SetForegroundWindow($script:main)
[void][R2]::ShowWindow($script:main, 6)   # minimize
Start-Sleep -Milliseconds 600
[void][R2]::ShowWindow($script:main, 9)   # restore
Start-Sleep -Milliseconds 1500
$r = New-Object R2+RECT
[void][R2]::GetWindowRect($script:main, [ref]$r)
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $hh))
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("SHOT {0} {1}x{2}" -f $Out, $w, $hh)
