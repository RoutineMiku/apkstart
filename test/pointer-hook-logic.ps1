# Smoke-test the mouse mapping INSIDE agent.ps1 without starting a real emulator.
# Loads the embedded C# and drives the private hook callback via reflection.
# InOurLcd() needs a real foreground window, which a CI / non-interactive session
# has none of; the compiled copy therefore gets a test-only early return that
# fakes a fixed LCD rectangle. Everything else runs the production code as-is.
# Run: powershell -ExecutionPolicy Bypass -File test/pointer-hook-logic.ps1
$ErrorActionPreference = 'Stop'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$path = Join-Path $PSScriptRoot '..\src\core\win\agent.ps1'
$text = Get-Content -Raw -LiteralPath $path
$m = [regex]::Match($text, "(?s)@'\r?\n(.*?)\r?\n'@")
if (-not $m.Success) { Write-Output 'FAIL=no-source'; exit 1 }
$src = $m.Groups[1].Value
$fake = @'
    static bool InOurLcd(POINT pt, out RECT r)
    {
        r = new RECT(); r.L = 100; r.T = 100; r.R = 620; r.B = 520;
        return pt.X >= 200 && pt.X <= 500 && pt.Y >= 200 && pt.Y <= 450;
    }
'@
$pat = '(?s)    static bool InOurLcd\(POINT pt, out RECT r\).*?\r?\n    \}'
$src2 = [regex]::Replace($src, $pat, $fake, 1)
if ($src2 -eq $src -or -not $src2.Contains('r.L = 100')) { Write-Output 'FAIL=InOurLcd not found'; exit 1 }
# Unique type name: agent-compile.ps1 may have defined ApkAgent in this process.
$src2 = $src2 -creplace 'public class ApkAgent', 'public class ApkAgentHookTest'
if (-not $src2.Contains('class ApkAgentHookTest')) { Write-Output 'FAIL=class rename'; exit 1 }
$defined = Add-Type -TypeDefinition $src2 -PassThru -ErrorAction Stop
$t = $defined | Where-Object { $_.Name -eq 'ApkAgentHookTest' } | Select-Object -First 1
if ($null -eq $t) { Write-Output 'FAIL=type not defined'; exit 1 }
$flags = [System.Reflection.BindingFlags]'NonPublic, Static'
function F($n) { return $t.GetField($n, $flags) }
function M($n) { return $t.GetMethod($n, $flags) }
function SetField($name, $value) { $f = F($name); $f.SetValue($null, $value) }
function SetOpt($right, $wheel, $side) {
  SetField '_optRight' ([int]$right)
  SetField '_optWheel' ([int]$wheel)
  SetField '_optSide' ([int]$side)
}
function DrainEvents {
  $qf = F('_events')
  $q = $qf.GetValue($null)
  $try = $q.GetType().GetMethod('TryDequeue')
  $out = @()
  $a = [object[]]@($null)
  while ($try.Invoke($q, $a)) { $out += $a[0]; $a[0] = $null }
  return ,$out
}
function Check($ok, $msg) { if (-not $ok) { Write-Output "FAIL=$msg"; exit 1 } }

# --- JSON config parsing used by the "hook" command ---
Check ((M 'L').Invoke($null, [object[]]@('{"cmd":"hook","on":1,"right":1,"wheel":1,"side":0}', 'right')) -eq 1) 'parse right'
Check ((M 'L').Invoke($null, [object[]]@('{"cmd":"hook","on":1,"right":1,"wheel":1,"side":0}', 'wheel')) -eq 1) 'parse wheel'
Check ((M 'L').Invoke($null, [object[]]@('{"cmd":"hook","on":1,"right":1,"wheel":1,"side":0}', 'side')) -eq 0) 'parse side'
Check ((M 'S').Invoke($null, [object[]]@('{"cmd":"hook","on":1}', 'cmd')) -eq 'hook') 'parse cmd'

SetField '_host' ([IntPtr]1)
SetField '_emu' ([IntPtr]::Zero)
$px = 300
$py = 300

# --- Helper to build a MSLLHOOKSTRUCT and invoke HookCallback ---
$msType = $t.GetNestedType('MSLLHOOKSTRUCT')
$ptType = $t.GetNestedType('POINT')
$hook = M 'HookCallback'
function InvokeHook([int]$msg, [int]$x, [int]$y, [int]$mouseData) {
  $pt = [Activator]::CreateInstance($ptType)
  $pt.GetType().GetField('X').SetValue($pt, $x)
  $pt.GetType().GetField('Y').SetValue($pt, $y)
  $ms = [Activator]::CreateInstance($msType)
  $ms.GetType().GetField('Pt').SetValue($ms, $pt)
  $ms.GetType().GetField('MouseData').SetValue($ms, $mouseData)
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf($ms)
  $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [System.Runtime.InteropServices.Marshal]::StructureToPtr($ms, $ptr, $false)
    return $hook.Invoke($null, [object[]]@([int]0, [IntPtr]$msg, $ptr)).ToInt64()
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
  }
}

$wheelDown = [int](-120 * 65536)   # high word = -120
$wheelUp = [int](120 * 65536)

# 1) Right click inside the LCD -> swallowed + one "back" event
SetOpt 1 0 0
DrainEvents | Out-Null
$r1 = InvokeHook 0x0204 $px $py 0
Check ($r1 -eq 1) 'right click must be swallowed'
$e = DrainEvents
Check ($e.Count -eq 1 -and $e[0] -match '"ev":"back"') 'right click must emit exactly one back event'

# 2) Right click OUTSIDE our window -> passed through, no event
$r2 = InvokeHook 0x0204 ($px + 9000) ($py + 9000) 0
Check ($r2 -ne 1) 'foreign right click must pass through'
Check ((DrainEvents).Count -eq 0) 'foreign right click must not emit events'

# 3) Wheel: three notches coalesce into ONE wheel event with normalized coords
SetOpt 0 1 0
DrainEvents | Out-Null
$w1 = InvokeHook 0x020A $px $py $wheelDown
$w2 = InvokeHook 0x020A $px $py $wheelDown
$w3 = InvokeHook 0x020E $px $py $wheelUp
Check ($w1 -eq 1 -and $w2 -eq 1 -and $w3 -eq 1) 'wheel events must be swallowed'
Check ((DrainEvents).Count -eq 0) 'wheel must not be emitted before coalescing'
(M 'FlushWheel').Invoke($null, [object[]]@($true)) | Out-Null
$e = DrainEvents
Check ($e.Count -eq 1) 'three notches must become one wheel event'
Check ($e[0] -match '"dy":-240') 'vertical deltas must be summed'
Check ($e[0] -match '"dx":120') 'horizontal delta must be kept'
Check ($e[0] -match '"nx":0\.\d+' -and $e[0] -match '"ny":0\.\d+') 'normalized cursor must be reported'
Check (-not ($e[0] -match 'NaN|Infinity')) 'normalized coords must be finite'

# 4) All options off -> absolutely nothing is intercepted
SetOpt 0 0 0
DrainEvents | Out-Null
$w4 = InvokeHook 0x020A $px $py $wheelDown
$r4 = InvokeHook 0x0204 $px $py 0
Check ($w4 -ne 1 -and $r4 -ne 1) 'disabled options must not swallow anything'
(M 'FlushWheel').Invoke($null, [object[]]@($true)) | Out-Null
Check ((DrainEvents).Count -eq 0) 'disabled options must not emit events'

(M 'HookOff').Invoke($null, [object[]]@()) | Out-Null
Write-Output 'POINTER_HOOK_LOGIC_OK'
