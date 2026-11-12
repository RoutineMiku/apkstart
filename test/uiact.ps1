# UI action probe (ASCII only): synthesize real mouse input for acceptance tests.
#   click  X Y      left click at screen coords
#   xdown / xup     side button 1 (BROWSER_BACK) press / release
#   move   X Y      move cursor
param([string]$Act = "click", [int]$X = 0, [int]$Y = 0)

$src = @'
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, IntPtr extra);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, XDOWN = 0x0080, XUP = 0x0100;
}
'@
Add-Type -TypeDefinition $src -Language CSharp

switch ($Act) {
  "move"  { [void][M]::SetCursorPos($X, $Y); Write-Output "moved $X,$Y" }
  "click" {
    [void][M]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 120
    [M]::mouse_event([M]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [M]::mouse_event([M]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Write-Output "clicked $X,$Y"
  }
  "xdown" { [M]::mouse_event([M]::XDOWN, 0, 0, 1, [IntPtr]::Zero); Write-Output "xdown" }
  "xup"   { [M]::mouse_event([M]::XUP, 0, 0, 1, [IntPtr]::Zero); Write-Output "xup" }
  default { Write-Output "unknown act $Act" }
}
