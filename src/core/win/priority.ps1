# ApkStart process priority helper (ASCII only).
# QEMU is a CPU-hungry guest. Running it at Normal priority competes with the
# Windows shell, the pointer and every foreground app -- which is exactly what
# makes the whole desktop feel laggy while an Android app is open.
#
# We lower ONLY the emulator/qemu processes whose command line references our
# AVD name, so other people's emulators are never touched.
#   idle   : no app open, container parked (lowest CPU claim)
#   below  : app open, still yield to the Windows foreground
#   normal : user explicitly asked for maximum guest performance
param(
  [string]$Avd = 'apkstart',
  [ValidateSet('idle', 'below', 'normal')][string]$Level = 'below'
)

$ErrorActionPreference = 'SilentlyContinue'
$map = @{ idle = 'Idle'; below = 'BelowNormal'; normal = 'Normal' }
$want = $map[$Level]
$changed = 0

try {
  $procs = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(qemu-system-x86_64|emulator)\.exe$' -and
    $_.CommandLine -like "*$Avd*"
  }
  foreach ($p in $procs) {
    $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($null -ne $gp) {
      try { $gp.PriorityClass = $want; $changed++ } catch { }
    }
  }
} catch { }

"CHANGED=$changed"
