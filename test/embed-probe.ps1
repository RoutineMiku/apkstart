# Throwaway probe: can the emulator Qt window be re-parented into another HWND
# and still render? Creates a WinForms host, SetParent()s the emulator window in,
# screenshots the host, then detaches. ASCII only.
param(
  [string]$Out = "embed.png",
  [int]$W = 540,
  [int]$H = 960
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr c);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@

function Find-EmuWindow {
  $script:found = [IntPtr]::Zero
  $cb = [W+EnumProc]{
    param($h, $p)
    $script:pid2 = 0
    [void][W]::GetWindowThreadProcessId($h, [ref]$script:pid2)
    $proc = Get-Process -Id $script:pid2 -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'qemu|emulator' -and [W]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][W]::GetClassNameW($h, $sb, 512)
      $cls = $sb.ToString()
      if ($cls -notmatch 'IME|MSCTF') {
        $script:found = $h
        Write-Output ("CAND hwnd={0} pid={1} cls={2} name={3}" -f $h, $script:pid2, $cls, $proc.ProcessName)
      }
    }
    return $true
  }
  [void][W]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

$emu = Find-EmuWindow
if ($emu -eq [IntPtr]::Zero) { Write-Output 'ERR=no-emu-window'; exit 1 }

$r = New-Object W+RECT
[void][W]::GetWindowRect($emu, [ref]$r)
Write-Output ("BEFORE x={0} y={1} w={2} h={3}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ApkStartHost'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point 40, 40
$form.ClientSize = New-Object System.Drawing.Size $W, $H
$form.FormBorderStyle = 'None'
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 24)
[void]$form.Show()
Start-Sleep -Milliseconds 400

# re-parent + restyle as child
[void][W]::SetParent($emu, $form.Handle)
$style = [W]::GetWindowLong($emu, -16)
$style = ($style -band (-bnot 0x00C00000)) -band (-bnot 0x80000000)
$style = $style -bor 0x40000000 -bor 0x10000000
[void][W]::SetWindowLong($emu, -16, $style)
[void][W]::SetWindowPos($emu, [IntPtr]::Zero, 0, 0, $W, $H, 0x0160)  # NOMOVE? no: NOZORDER|FRAMECHANGED|SHOWWINDOW
[void][W]::ShowWindow($emu, 5)
[void][W]::SetWindowPos($emu, [IntPtr]::Zero, 0, 0, $W, $H, 0x0160)
$form.Activate()

# let it repaint a few frames
$deadline = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $deadline) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 120
}

$gr = $form.CreateGraphics()
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g2 = [System.Drawing.Graphics]::FromImage($bmp)
$g2.CopyFromScreen($form.Location, [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $W, $H))
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("SAVED={0}" -f $Out)

# detach back to the desktop so the emulator is not orphaned
[void][W]::SetParent($emu, [IntPtr]::Zero)
$style2 = [W]::GetWindowLong($emu, -16)
$style2 = ($style2 -band (-bnot 0x40000000)) -bor 0x00C00000 -bor 0x00080000
[void][W]::SetWindowLong($emu, -16, $style2)
[void][W]::SetWindowPos($emu, [IntPtr]::Zero, 80, 40, 420, 760, 0x0160)
[void][W]::ShowWindow($emu, 9)
Write-Output 'DETACHED'
$form.Close()
