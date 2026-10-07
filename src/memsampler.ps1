param(
  [Parameter(Mandatory = $true)][string]$ReqFile,
  [Parameter(Mandatory = $true)][string]$ResFile,
  [int]$IdleMs = 45000,
  [string]$PortFile = '',
  [int]$SampleIntervalMs = 1
)
# Memory sampler for the Windows judge (one long-lived process per submission / per judge slot).
#
# Why: looking a child process up through a fresh PowerShell costs ~5s on a loaded machine, so the
# judge spawns the contestant program directly from Node (fast, exact exit code) and this long-lived
# sampler - started once per submission, pooled across submissions - measures its working set.
#
# Two request channels (the response always goes back through $ResFile):
#   * UDP on 127.0.0.1 (fast, ~1 ms): Node reads the port from $PortFile and sends
#     { pid, untilMs, nonce, ts }. Needed because a trivial C++ program lives only ~10 ms.
#   * $ReqFile (always written by Node as well): the fallback channel, works even when the
#     UDP socket could not be created (firewall/sandbox), at ~15 ms latency.
#
# Measuring: [System.Diagnostics.Process]::GetProcessById(pid) opens a handle while the process is
# still alive; Windows keeps reporting PeakWorkingSet64 for a terminated process as long as that
# handle is open, so the peak is exact and even a 1 ms process cannot be missed between samples.
# WorkingSet64 is also polled while the process runs (needed both as a fallback and because reading
# it is what makes the cached process info valid).
#
# A response with peakBytes = 0 (or no response at all) means "not sampled": the judge then records
# memory_sampled = false and never treats it as 0 KB / MLE. Sampling never influences the verdict.
#
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads .ps1 as ANSI without a BOM).

$ErrorActionPreference = 'SilentlyContinue'

function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# Shared read: must NOT deny writes, otherwise the judge's write to the request file fails (EBUSY).
function Read-SharedText([string]$path) {
  $fs = $null
  $sr = $null
  try {
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $sr = New-Object System.IO.StreamReader($fs)
    return $sr.ReadToEnd()
  } catch {
    return ''
  } finally {
    if ($sr) { try { $sr.Close() } catch { } }
    if ($fs) { try { $fs.Close() } catch { } }
  }
}

# Shared write: the judge polls this file while we write it, so allow readers (partial reads are
# tolerated by the judge, which only trusts a response carrying its own nonce).
function Write-SharedText([string]$path, [string]$text) {
  $fs = $null
  try {
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush()
    return $true
  } catch {
    return $false
  } finally {
    if ($fs) { try { $fs.Close() } catch { } }
  }
}

function ConvertTo-Request([string]$raw) {
  if (-not $raw) { return $null }
  $mp = [regex]::Match($raw, '"pid"\s*:\s*(\d+)')
  if (-not $mp.Success) { return $null }
  $mn = [regex]::Match($raw, '"nonce"\s*:\s*"([^"]*)"')
  $mu = [regex]::Match($raw, '"untilMs"\s*:\s*(\d+)')
  return @{
    pid = [int]$mp.Groups[1].Value
    nonce = $(if ($mn.Success) { $mn.Groups[1].Value } else { '' })
    untilMs = $(if ($mu.Success) { [int64]$mu.Groups[1].Value } else { 0 })
  }
}

# Optional UDP fast channel (loopback only: no firewall prompt, no external exposure).
$udp = $null
$remote = $null
$udpOk = $false
if ($PortFile) {
  try {
    $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Loopback, 0)
    $udp = New-Object System.Net.Sockets.UdpClient($ep)
    $udp.Client.ReceiveTimeout = 15
    $port = ([System.Net.IPEndPoint]$udp.Client.LocalEndPoint).Port
    $udpOk = Write-SharedText $PortFile ('{"port":' + $port + ',"pid":' + $PID + '}')
  } catch {
    $udp = $null
    $udpOk = $false
  }
}

$lastNonce = ''
$idleStart = Get-NowMs
$fastUntil = 0
$maxWaitMs = 8000
# Poll interval between two WorkingSet64 reads (ms). The judge passes judge_mem_sample_interval_ms
# (default 1, clamped 0..50). 0 is allowed and means "yield, do not sleep" (densest sampling).
if ($SampleIntervalMs -lt 0) { $SampleIntervalMs = 0 }
if ($SampleIntervalMs -gt 50) { $SampleIntervalMs = 50 }

while ($true) {
  $req = $null
  if ($udp) {
    try {
      $data = $udp.Receive([ref]$remote)
      if ($data -and $data.Length -gt 0) {
        $req = ConvertTo-Request ([System.Text.Encoding]::UTF8.GetString($data))
      }
    } catch { }
  }
  if (-not $req) { $req = ConvertTo-Request (Read-SharedText $ReqFile) }

  $now = Get-NowMs
  if (-not $req -or $req.pid -le 0 -or $req.nonce -eq $lastNonce) {
    if ($IdleMs -gt 0 -and ($now - $idleStart) -gt $IdleMs) { exit 0 }
    # Without UDP the only way to catch a ~10 ms process is to poll the request file in a tight
    # window right after a test case (cases run back to back); otherwise poll at ~15 ms (cheap).
    if (-not $udpOk -and $now -lt $fastUntil) { [System.Threading.Thread]::Sleep(0) } else { [System.Threading.Thread]::Sleep(1) }
    continue
  }

  $lastNonce = $req.nonce
  $targetPid = $req.pid
  $idleStart = $now
  $peak = 0
  $seen = 0
  $proc = $null
  try { $proc = [System.Diagnostics.Process]::GetProcessById($targetPid) } catch { $proc = $null }
  if ($proc) {
    $seen = 1
    # Do not wait forever on a runaway process: the judge kills it at its own timeout, and the
    # request carries a deadline a bit beyond that.
    $waitMs = $maxWaitMs
    if ($req.untilMs -gt 0) {
      $left = $req.untilMs - (Get-NowMs)
      if ($left -lt $waitMs) { $waitMs = [int]$left + 500 }
    }
    if ($waitMs -lt 200) { $waitMs = 200 }
    $deadline = (Get-NowMs) + $waitMs
    # Tight sampling for the first ~60 ms (covers short-lived programs), then ~15 ms polls.
    # NOTE: System.Diagnostics.Process caches its process info snapshot, so **Refresh() must be
    # called before every read** - otherwise WorkingSet64/PeakWorkingSet64 keep returning the value
    # captured when the handle was opened (measured: a program that touched 600 MB was reported as
    # 2.7 MB). PeakWorkingSet64 from a refreshed live handle is the OS's own peak, so even a single
    # successful read right before exit yields the exact peak.
    $tightUntil = (Get-NowMs) + 60
    while ($true) {
      try {
        $proc.Refresh()
        if ($proc.HasExited) { break }
        $ws = $proc.WorkingSet64
        if ($ws -gt $peak) { $peak = $ws }
        $pkLive = $proc.PeakWorkingSet64
        if ($pkLive -gt $peak) { $peak = $pkLive }
      } catch { break }
      $n2 = Get-NowMs
      if ($n2 -ge $deadline) { break }
      # Tight sampling for the first ~60 ms (covers short-lived programs), then poll at the
      # configured interval instead of the historical fixed 1 ms.
      if ($n2 -lt $tightUntil) { [System.Threading.Thread]::Sleep(0) } else { [System.Threading.Thread]::Sleep($SampleIntervalMs) }
    }
    # Exact peak: works on a terminated process as long as we opened the handle while it was alive.
    try {
      $proc.Refresh()
      $pk = $proc.PeakWorkingSet64
      if ($pk -gt $peak) { $peak = $pk }
    } catch { }
    if ($peak -le 0) {
      try {
        $ws = $proc.WorkingSet64
        if ($ws -gt $peak) { $peak = $ws }
      } catch { }
    }
    try { $proc.Dispose() } catch { }
  }

  # Echo the caller's nonce back: the judge only trusts a response carrying the nonce it sent,
  # so a response file forged by a contestant process cannot fake memory usage (H2).
  $json = '{"pid":' + $targetPid + ',"peakBytes":' + $peak + ',"seen":' + $seen + ',"nonce":"' + $req.nonce + '"}'
  [void](Write-SharedText $ResFile $json)
  $fastUntil = (Get-NowMs) + 250
}
