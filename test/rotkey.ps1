# Post Ctrl+Left directly to the emulator child window (no focus needed).
param([string]$Key = "left")

$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class K {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

function Find-Emu($h) {
  $c = [K]::GetWindow($h, 5)
  $i = 0
  while ($c -ne [IntPtr]::Zero -and $i -lt 30) {
    if ([K]::Cls($c).Contains("QWindowIcon")) { return $c }
    $i++
    $c = [K]::GetWindow($c, 2)
  }
  return [IntPtr]::Zero
}

$emu = [IntPtr]::Zero
$d = [K]::GetWindow([K]::GetDesktopWindow(), 5)
$k = 0
while ($d -ne [IntPtr]::Zero -and $k -lt 500 -and $emu -eq [IntPtr]::Zero) {
  if ([K]::Cls($d) -eq "Chrome_WidgetWin_1") { $emu = Find-Emu $d }
  $k++
  $d = [K]::GetWindow($d, 2)
}
if ($emu -eq [IntPtr]::Zero) { Write-Output "EMU not found"; exit 1 }

$r = New-Object K+RECT
[void][K]::GetWindowRect($emu, [ref]$r)
Write-Output ("BEFORE {0}x{1}" -f ($r.R - $r.L), ($r.B - $r.T))

$vk = if ($Key -eq "right") { 0x27 } else { 0x25 }
# WM_KEYDOWN=0x100 WM_KEYUP=0x101
[void][K]::PostMessage($emu, 0x100, [IntPtr]0x11, [IntPtr]0)
Start-Sleep -Milliseconds 60
[void][K]::PostMessage($emu, 0x100, [IntPtr]$vk, [IntPtr]0)
Start-Sleep -Milliseconds 80
[void][K]::PostMessage($emu, 0x101, [IntPtr]$vk, [IntPtr]0)
[void][K]::PostMessage($emu, 0x101, [IntPtr]0x11, [IntPtr]0)

Start-Sleep -Milliseconds 1500
$r2 = New-Object K+RECT
[void][K]::GetWindowRect($emu, [ref]$r2)
Write-Output ("AFTER  {0}x{1}" -f ($r2.R - $r2.L), ($r2.B - $r2.T))
