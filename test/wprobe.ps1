# Probe child-window z-order of the ApkStart app window (ASCII only).
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);

  public static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static string Txt(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); return sb.ToString(); }
  public static bool Cloaked(IntPtr h) { int v; int r = DwmGetWindowAttribute(h, 14, out v, 4); return r == 0 && v != 0; }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

function Show-Node($h, $depth, $label) {
  $r = New-Object W+RECT
  [void][W]::GetWindowRect($h, [ref]$r)
  $cr = New-Object W+RECT
  [void][W]::GetClientRect($h, [ref]$cr)
  $st = [int64][W]::GetWindowLongPtr($h, -16)
  $ex = [int64][W]::GetWindowLongPtr($h, -20)
  $child = ($st -band 0x40000000) -ne 0
  $vis = [W]::IsWindowVisible($h)
  $cloak = [W]::Cloaked($h)
  $pad = ("  " * $depth)
  Write-Output ("{0}[{1}] hwnd={2} cls='{3}' vis={4} child={5} cloak={6} style=0x{7:X8} ex=0x{8:X8} rect={9},{10} {11}x{12} client={13}x{14} txt='{15}'" -f `
    $pad, $label, $h, [W]::Cls($h), $vis, $child, $cloak, $st, $ex, $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T), $cr.R, $cr.B, [W]::Txt($h))
}

function Has-EmuChild($h) {
  $c = [W]::GetWindow($h, 5)
  $i = 0
  while ($c -ne [IntPtr]::Zero -and $i -lt 30) {
    $cls = [W]::Cls($c)
    if ($cls.Contains("QWindowIcon")) { return $true }
    $i++
    $c = [W]::GetWindow($c, 2)
  }
  return $false
}

$hostWnd = [IntPtr]::Zero
$d = [W]::GetWindow([W]::GetDesktopWindow(), 5)
$k = 0
while ($d -ne [IntPtr]::Zero -and $k -lt 500) {
  if ([W]::Cls($d) -eq "Chrome_WidgetWin_1" -and (Has-EmuChild $d)) { $hostWnd = $d; break }
  $k++
  $d = [W]::GetWindow($d, 2)
}
if ($hostWnd -eq [IntPtr]::Zero) { Write-Output "HOST with embedded emulator not found"; exit 1 }

Show-Node $hostWnd 0 "HOST"
$c = [W]::GetWindow($hostWnd, 5)
$i = 0
while ($c -ne [IntPtr]::Zero -and $i -lt 20) {
  Show-Node $c 1 ("child#{0} (0=topmost)" -f $i)
  $i++
  $c = [W]::GetWindow($c, 2)
}
Write-Output "--- emulator top-level windows still around"
$d = [W]::GetWindow([W]::GetDesktopWindow(), 5)
$k = 0
while ($d -ne [IntPtr]::Zero -and $k -lt 500) {
  $cls = [W]::Cls($d)
  if ($cls.Contains("QWindow")) { Show-Node $d 0 "TOP" }
  $k++
  $d = [W]::GetWindow($d, 2)
}
