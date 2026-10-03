param(
  [Parameter(Mandatory = $true)][string]$ReqFile,
  [Parameter(Mandatory = $true)][string]$ResFile,
  [int]$IdleMs = 25000
)
# Memory sampler for the Windows judge (one long-lived process per submission).
#
# Why: launching a PowerShell process per test case costs about 0.7s, and looking the child
# process up through WMI costs another ~0.8s per case. Instead the judge spawns the user program
# directly from Node (fast, exact exit code) and this sampler - started once per submission -
# samples the working set of the running process it is told about through two small files:
#
#   request  (written by Node): { pid: <number>, untilMs: <unix ms deadline> }
#   response (written by here): { pid: <number>, peakBytes: <number> }
#
# Node writes a request right after spawning a test case and reads the response once the process
# exited. The sampler exits by itself after $IdleMs without new requests.
#
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads .ps1 as ANSI without a BOM).
$ErrorActionPreference = 'SilentlyContinue'

function Read-Request {
  try {
    if (-not (Test-Path -LiteralPath $ReqFile)) { return $null }
    $raw = Get-Content -LiteralPath $ReqFile -Raw
    if (-not $raw) { return $null }
    return $raw | ConvertFrom-Json
  } catch { return $null }
}

$lastPid = 0
$idleStart = [DateTime]::UtcNow
while ($true) {
  $req = Read-Request
  $targetPid = 0
  $until = 0
  if ($req) {
    $targetPid = [int]$req.pid
    $until = [int64]$req.untilMs
  }
  if ($targetPid -le 0) {
    Start-Sleep -Milliseconds 20
    if (([DateTime]::UtcNow - $idleStart).TotalMilliseconds -gt $IdleMs) { exit 0 }
    continue
  }

  $peak = 0
  $idleStart = [DateTime]::UtcNow
  # Sample while the target process is alive and before the case deadline
  while ($true) {
    $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $p) { break }
    try {
      $ws = $p.WorkingSet64
      if ($ws -gt $peak) { $peak = $ws }
    } catch { }
    if ($until -gt 0 -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $until) { break }
    Start-Sleep -Milliseconds 12
  }

  @{ pid = $targetPid; peakBytes = $peak } | ConvertTo-Json -Compress | Out-File -LiteralPath $ResFile -Encoding utf8
  $lastPid = $targetPid

  # Wait for the next request (different pid) or idle out
  $waitStart = [DateTime]::UtcNow
  while ($true) {
    Start-Sleep -Milliseconds 15
    $r2 = Read-Request
    if ($r2 -and [int]$r2.pid -ne $lastPid) { break }
    if (([DateTime]::UtcNow - $waitStart).TotalMilliseconds -gt $IdleMs) { exit 0 }
  }
}
