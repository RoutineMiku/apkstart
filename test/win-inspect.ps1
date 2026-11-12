# Inspect parent/style/rect of every emulator Qt window + the Electron host window.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class P3 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$script:rows = New-Object System.Collections.ArrayList
$cb = [P3+EnumProc]{
  param($h, $p)
  $pp = 0
  [void][P3]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if (-not $proc) { return $true }
  if ($proc.ProcessName -notmatch 'qemu|electron|ApkStart') { return $true }
  $cls = New-Object System.Text.StringBuilder 256
  [void][P3]::GetClassNameW($h, $cls, 256)
  $txt = New-Object System.Text.StringBuilder 256
  [void][P3]::GetWindowTextW($h, $txt, 256)
  $r = New-Object P3+RECT
  [void][P3]::GetWindowRect($h, [ref]$r)
  $st = [P3]::GetWindowLong($h, -16)
  [void]$script:rows.Add(("pid={0} proc={1} hwnd={2} vis={3} cls='{4}' title='{5}' rect={6},{7} {8}x{9} parent={10} child={11} style=0x{12:X}" -f `
    $pp, $proc.ProcessName, $h, [P3]::IsWindowVisible($h), $cls.ToString(), $txt.ToString(), `
    $r.L, $r.T, ($r.R-$r.L), ($r.B-$r.T), [P3]::GetParent($h), `
    (([P3]::GetWindowLong($h,-16) -band 0x40000000) -ne 0), $st))
  return $true
}
[void][P3]::EnumWindows($cb, [IntPtr]::Zero)
$script:rows | ForEach-Object { Write-Output $_ }
