# Compile-check the C# embedded in agent.ps1 without starting the agent.
$path = Join-Path $PSScriptRoot '..\src\core\win\agent.ps1'
$text = Get-Content $path -Raw
$m = [regex]::Match($text, "(?s)@'\r?\n(.*?)\r?\n'@")
if (-not $m.Success) { Write-Output 'ERR=no-source'; exit 1 }
$src = $m.Groups[1].Value
try {
  Add-Type -TypeDefinition $src
  Write-Output 'COMPILE_OK'
} catch {
  $e = $_.Exception
  Write-Output ('COMPILE_FAIL: ' + $e.Message)
  if ($e.InnerException) { Write-Output ('INNER: ' + $e.InnerException.Message) }
}
