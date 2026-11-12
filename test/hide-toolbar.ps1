# Hide the emulator's floating side toolbar (class contains QWindowTool).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class H {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$script:out = New-Object System.Collections.ArrayList
$cb = [H+EnumProc]{
  param($h, $p)
  $pp = 0
  [void][H]::GetWindowThreadProcessId($h, [ref]$pp)
  $proc = Get-Process -Id $pp -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -notmatch 'qemu') { return $true }
  $cls = New-Object System.Text.StringBuilder 256
  [void][H]::GetClassNameW($h, $cls, 256)
  if ($cls.ToString() -match 'QWindowTool' -and [H]::IsWindowVisible($h)) {
    [void][H]::ShowWindow($h, 0)
    [void]$script:out.Add("HIDDEN $h")
  }
  return $true
}
[void][H]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:out.Count -eq 0) { Write-Output 'none' } else { $script:out | ForEach-Object { Write-Output $_ } }
