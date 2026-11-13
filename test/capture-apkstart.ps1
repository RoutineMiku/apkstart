# Capture the ApkStart main window (with embedded Android view) to PNG. v2
param([string]$Out = "hongguo-final.png")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W4 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$found = New-Object System.Collections.ArrayList
$cb = [W4+EnumProc]{ param($h, $p)
  if (-not [W4]::IsWindowVisible($h)) { return $true }
  $pp = 0
  [void][W4]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if (-not $proc) { return $true }
  if ($proc.Name -ne 'ApkStart') { return $true }
  $len = [W4]::GetWindowTextLength($h)
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][W4]::GetWindowText($h, $sb, $len + 2)
  $r = New-Object W4+RECT
  [void][W4]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -lt 200 -or $hh -lt 200) { return $true }
  [void]$found.Add([PSCustomObject]@{ Hwnd = $h; Title = $sb.ToString(); W = $w; H = $hh; Rect = $r })
  return $true
}
[void][W4]::EnumWindows($cb, [IntPtr]::Zero)
if ($found.Count -eq 0) { Write-Output 'ERR=no-ApkStart-window'; exit 1 }
$win = $found | Sort-Object { $_.W * $_.H } -Descending | Select-Object -First 1
Write-Output ("FOUND: '{0}' {1}x{2}" -f $win.Title, $win.W, $win.H)
[void][W4]::ShowWindow($win.Hwnd, 9)
[void][W4]::SetForegroundWindow($win.Hwnd)
Start-Sleep -Milliseconds 2000
$r = New-Object W4+RECT
[void][W4]::GetWindowRect($win.Hwnd, [ref]$r)
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $hh))
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("SHOT {0} {1}x{2}" -f $Out, $w, $hh)
