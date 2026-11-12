# Probe 2: embed with the 8px emulator padding shifted outside the host,
# so the Android framebuffer fills the host exactly and the side rail is clipped.
param([int]$W = 480, [int]$H = 853, [int]$Margin = 8, [string]$Out = "embed2.png", [switch]$Keep)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W3 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
$script:hwnd = [IntPtr]::Zero
$cb = [W3+EnumProc]{
  param($h, $p)
  $pp = 0
  [void][W3]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if (-not $proc) { return $true }
  if ($proc.ProcessName -notmatch 'qemu') { return $true }
  if (-not [W3]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 256
  [void][W3]::GetClassNameW($h, $sb, 256)
  if ($sb.ToString() -match 'IME|MSCTF') { return $true }
  $script:hwnd = $h
  return $true
}
[void][W3]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:hwnd -eq [IntPtr]::Zero) { Write-Output 'ERR=no-window'; exit 1 }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Host'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point 60, 30
$form.ClientSize = New-Object System.Drawing.Size $W, $H
$form.FormBorderStyle = 'None'
$form.BackColor = [System.Drawing.Color]::FromArgb(0, 0, 0)
[void]$form.Show()
Start-Sleep -Milliseconds 300

[void][W3]::SetParent($script:hwnd, $form.Handle)
$st = [W3]::GetWindowLong($script:hwnd, -16)
$st = ($st -band (-bnot 0x00C00000)) -band (-bnot 0x80000000)
$st = $st -bor 0x40000000 -bor 0x10000000
[void][W3]::SetWindowLong($script:hwnd, -16, $st)
[void][W3]::SetWindowPos($script:hwnd, [IntPtr]::Zero, -$Margin, -$Margin, ($W + 2 * $Margin), ($H + 2 * $Margin), 0x0160)
[void][W3]::ShowWindow($script:hwnd, 5)
$form.Activate()

$deadline = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }

$bmp = New-Object System.Drawing.Bitmap $W, $H
$g2 = [System.Drawing.Graphics]::FromImage($bmp)
$g2.CopyFromScreen($form.Location, [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $W, $H))
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("SAVED {0} {1}x{2}" -f $Out, $W, $H)

if (-not $Keep) {
  [void][W3]::SetParent($script:hwnd, [IntPtr]::Zero)
  $st2 = [W3]::GetWindowLong($script:hwnd, -16)
  $st2 = ($st2 -band (-bnot 0x40000000)) -bor 0x00C00000 -bor 0x00080000
  [void][W3]::SetWindowLong($script:hwnd, -16, $st2)
  [void][W3]::SetWindowPos($script:hwnd, [IntPtr]::Zero, 40, 20, 540, 999, 0x0160)
}
$form.Close()
