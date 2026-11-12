# Focus the emulator child window across processes, then press Ctrl+Left/Right.
param([string]$Key = "left")

$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class F {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetFocus();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }

  public static string Press(IntPtr host, IntPtr emu, byte vk) {
    uint emuTid = GetWindowThreadProcessId(emu, IntPtr.Zero);
    uint hostTid = GetWindowThreadProcessId(host, IntPtr.Zero);
    uint myTid = GetCurrentThreadId();
    AttachThreadInput(myTid, hostTid, true);
    AttachThreadInput(myTid, emuTid, true);
    SetForegroundWindow(host);
    IntPtr prev = SetFocus(emu);
    System.Threading.Thread.Sleep(150);
    keybd_event(0x11, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(50);
    keybd_event(vk, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    keybd_event(vk, 0, 2, IntPtr.Zero);
    keybd_event(0x11, 0, 2, IntPtr.Zero);
    System.Threading.Thread.Sleep(120);
    IntPtr now = GetFocus();
    SetFocus(prev);
    AttachThreadInput(myTid, emuTid, false);
    AttachThreadInput(myTid, hostTid, false);
    return (now == emu) ? "focus-ok" : "focus-miss";
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

$host_ = [IntPtr]::Zero
$emu = [IntPtr]::Zero
$d = [F]::GetWindow([F]::GetDesktopWindow(), 5)
$k = 0
while ($d -ne [IntPtr]::Zero -and $k -lt 500 -and $emu -eq [IntPtr]::Zero) {
  if ([F]::Cls($d) -eq "Chrome_WidgetWin_1") {
    $c = [F]::GetWindow($d, 5)
    $i = 0
    while ($c -ne [IntPtr]::Zero -and $i -lt 30) {
      if ([F]::Cls($c).Contains("QWindowIcon")) { $host_ = $d; $emu = $c; break }
      $i++
      $c = [F]::GetWindow($c, 2)
    }
  }
  $k++
  $d = [F]::GetWindow($d, 2)
}
if ($emu -eq [IntPtr]::Zero) { Write-Output "EMU not found"; exit 1 }

$r = New-Object F+RECT
[void][F]::GetWindowRect($emu, [ref]$r)
Write-Output ("BEFORE {0}x{1}" -f ($r.R - $r.L), ($r.B - $r.T))

$vk = if ($Key -eq "right") { 0x27 } else { 0x25 }
Write-Output ([F]::Press($host_, $emu, [byte]$vk))

Start-Sleep -Milliseconds 2000
$r2 = New-Object F+RECT
[void][F]::GetWindowRect($emu, [ref]$r2)
Write-Output ("AFTER  {0}x{1}" -f ($r2.R - $r2.L), ($r2.B - $r2.T))
