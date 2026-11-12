# List every top-level window of the emulator process(es) with class/rect/visible.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class L {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$script:lines = New-Object System.Collections.ArrayList
$cb = [L+EnumProc]{
  param($h, $p)
  $pp = 0
  [void][L]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match 'qemu|emulator') {
    $cls = New-Object System.Text.StringBuilder 256
    [void][L]::GetClassNameW($h, $cls, 256)
    $txt = New-Object System.Text.StringBuilder 256
    [void][L]::GetWindowTextW($h, $txt, 256)
    $r = New-Object L+RECT
    [void][L]::GetWindowRect($h, [ref]$r)
    [void]$script:lines.Add(("hwnd={0} pid={1} vis={2} cls='{3}' title='{4}' rect={5},{6} {7}x{8}" -f `
      $h, $pp, [L]::IsWindowVisible($h), $cls.ToString(), $txt.ToString(), `
      $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T)))
  }
  return $true
}
[void][L]::EnumWindows($cb, [IntPtr]::Zero)
$script:lines | ForEach-Object { Write-Output $_ }
