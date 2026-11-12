# List child windows of the ApkStart app window (the embedded emulator lives there).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class C4 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$script:hostWnd = [IntPtr]::Zero
$script:rows = New-Object System.Collections.ArrayList
$cb = [C4+EnumProc]{
  param($h, $p)
  $txt = New-Object System.Text.StringBuilder 256
  [void][C4]::GetWindowTextW($h, $txt, 256)
  if ($txt.ToString() -eq 'ApkStart') {
    $r = New-Object C4+RECT
    [void][C4]::GetWindowRect($h, [ref]$r)
    if (($r.R - $r.L) -gt 300 -and ($r.R - $r.L) -lt 800) { $script:hostWnd = $h }
  }
  return $true
}
[void][C4]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output ("HOST=" + $script:hostWnd)
if ($script:hostWnd -eq [IntPtr]::Zero) { exit 1 }
$ccb = [C4+EnumProc]{
  param($h, $p)
  $cls = New-Object System.Text.StringBuilder 256
  [void][C4]::GetClassNameW($h, $cls, 256)
  $r = New-Object C4+RECT
  [void][C4]::GetWindowRect($h, [ref]$r)
  [void]$script:rows.Add(("child hwnd={0} vis={1} cls='{2}' rect={3},{4} {5}x{6}" -f $h, [C4]::IsWindowVisible($h), $cls.ToString(), $r.L, $r.T, ($r.R-$r.L), ($r.B-$r.T)))
  return $true
}
[void][C4]::EnumChildWindows($script:hostWnd, $ccb, [IntPtr]::Zero)
$script:rows | ForEach-Object { Write-Output $_ }
