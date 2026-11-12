# Move the emulator main window to a known spot, then full-screen shot.
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MV {
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
$script:main = [IntPtr]::Zero
$cb = [MV+EnumProc]{
  param($h, $p)
  $pp = 0
  [void][MV]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -notmatch 'qemu') { return $true }
  if (-not [MV]::IsWindowVisible($h)) { return $true }
  $r = New-Object MV+RECT
  [void][MV]::GetWindowRect($h, [ref]$r)
  if (($r.R - $r.L) -gt 400) { $script:main = $h }
  return $true
}
[void][MV]::EnumWindows($cb, [IntPtr]::Zero)
[void][MV]::SetWindowPos($script:main, [IntPtr]::Zero, 700, 60, 540, 983, 0x0040)
[void][MV]::SetForegroundWindow($script:main)
Start-Sleep -Milliseconds 1500
$r = New-Object MV+RECT
[void][MV]::GetWindowRect($script:main, [ref]$r)
Write-Output ("MAIN {0},{1} {2}x{3}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size $b.Width, $b.Height))
$bmp.Save((Join-Path (Get-Location) 'screen2.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output 'SAVED screen2.png'
