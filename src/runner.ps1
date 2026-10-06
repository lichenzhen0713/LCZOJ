param(
  [Parameter(Mandatory = $true)][string]$JobFile,
  [Parameter(Mandatory = $true)][string]$ResultFile
)
# Judge runner wrapper (Windows).
#
# Starts the user process through cmd.exe so that stdin/stdout/stderr use file redirection
# (PowerShell 5.1 Start-Process loses ExitCode when redirecting). Elapsed time and timeout are
# measured from the user process itself (WMI discovery overhead is NOT counted against the limit),
# and peak memory is sampled from the child process WorkingSet64.
#
# Two job-file shapes are supported:
#   1) single : { exe, args, cwd, timeoutMs, stdinFile, stdoutFile, stderrFile }
#               -> writes one result object
#   2) batch  : { jobs: [ <single>, ... ] }
#               -> writes { results: [ <result>, ... ] }
# Batch mode lets one submission run all of its test cases inside a single PowerShell process,
# which removes the per-testcase process start plus WMI warm-up cost (about 1s+ each).
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads .ps1 as ANSI unless a BOM is present,
# so non-ASCII comments here would corrupt parsing.
$ErrorActionPreference = 'SilentlyContinue'

try {
  $raw = Get-Content -LiteralPath $JobFile -Raw
  $job = $raw | ConvertFrom-Json
} catch {
  @{ exitCode = -1; timedOut = $false; peakMemoryBytes = 0; durationMs = 0; errMsg = "cannot read job" } |
    ConvertTo-Json | Out-File -LiteralPath $ResultFile -Encoding utf8
  exit 0
}

# Warm up WMI before timing: the first Win32_Process enumeration can take over 1s.
try { Get-CimInstance -ClassName Win32_Process | Out-Null } catch { }

function Invoke-JudgeJob($job) {
  $timedOut = $false
  $peakBytes = 0
  $errMsg = ''

  # Build the cmd command line: exe args < in > out 2> err
  $argStr = ''
  foreach ($a in $job.args) {
    $argStr += ' "' + $a + '"'
  }
  if ($job.stdinFile) { $argStr += ' < "' + $job.stdinFile + '"' }
  if ($job.stdoutFile) { $argStr += ' > "' + $job.stdoutFile + '"' } else { $argStr += ' > NUL' }
  if ($job.stderrFile) { $argStr += ' 2> "' + $job.stderrFile + '"' } else { $argStr += ' 2> NUL' }
  $inner = '"' + $job.exe + '"' + $argStr
  $cmdLine = '"' + $inner + '"'

  $proc = $null
  try {
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdLine) -PassThru -WindowStyle Hidden
  } catch {
    return @{ exitCode = -1; timedOut = $false; peakMemoryBytes = 0; durationMs = 0; errMsg = "start failed: $($_.Exception.Message)" }
  }
  $startMoment = [DateTime]::UtcNow

  # Locate the real user process (cmd also spawns conhost.exe and other helpers, which must be skipped)
  $childProc = $null
  $childStart = $null
  $progName = ''
  try { $progName = [System.IO.Path]::GetFileName([string]$job.exe).ToLower() } catch { }
  try {
    $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($proc.Id)" -ErrorAction SilentlyContinue)
    $child = $null
    foreach ($k in $kids) {
      if ($k.Name -and $k.Name.ToLower() -eq $progName) { $child = $k; break }
    }
    if (-not $child) {
      foreach ($k in $kids) {
        if ($k.Name -and $k.Name.ToLower() -ne 'conhost.exe') { $child = $k; break }
      }
    }
    if (-not $child) {
      Start-Sleep -Milliseconds 20
      $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($proc.Id)" -ErrorAction SilentlyContinue)
      foreach ($k in $kids) {
        if ($k.Name -and $k.Name.ToLower() -eq $progName) { $child = $k; break }
      }
      if (-not $child) {
        foreach ($k in $kids) {
          if ($k.Name -and $k.Name.ToLower() -ne 'conhost.exe') { $child = $k; break }
        }
      }
    }
    if ($child) {
      $childProc = Get-Process -Id ([int]$child.ProcessId) -ErrorAction SilentlyContinue
      if ($childProc) { $childStart = $childProc.StartTime }
    }
  } catch { $childProc = $null; $childStart = $null }

  $timeoutMs = [int]$job.timeoutMs
  if ($timeoutMs -le 0) { $timeoutMs = 1000 }

  if ($childStart) {
    $deadline = $childStart.ToUniversalTime().AddMilliseconds($timeoutMs)
  } else {
    $deadline = $startMoment.AddMilliseconds($timeoutMs)
  }

  while ($true) {
    $exited = $false
    try {
      $proc.Refresh()
      $exited = $proc.HasExited
    } catch { $exited = $true }
    if ($exited) { break }
    if ([DateTime]::UtcNow -ge $deadline) { $timedOut = $true; break }
    if ($childProc) {
      try {
        $childProc.Refresh()
        if (-not $childProc.HasExited) {
          $ws = $childProc.WorkingSet64
          if ($ws -gt $peakBytes) { $peakBytes = $ws }
        }
      } catch { }
    } else {
      try {
        $ws = $proc.WorkingSet64
        if ($ws -gt $peakBytes) { $peakBytes = $ws }
      } catch { }
    }
    Start-Sleep -Milliseconds 10
  }

  $durMs = 0
  if ($childProc) {
    try {
      $childProc.Refresh()
      if ($childStart) {
        $durMs = [math]::Max(0, [int64](($childProc.ExitTime - $childStart).TotalMilliseconds))
      }
      $pk = $childProc.PeakWorkingSet64
      if ($pk -gt $peakBytes) { $peakBytes = $pk }
    } catch { }
  }
  if ($durMs -le 0) {
    try {
      $proc.Refresh()
      $durMs = [math]::Max(0, [int64](($proc.ExitTime - $proc.StartTime).TotalMilliseconds))
    } catch { }
  }
  if ($durMs -le 0) {
    $durMs = [math]::Max(0, [int64](([DateTime]::UtcNow - $startMoment).TotalMilliseconds))
  }

  if ($timedOut) {
    try { & taskkill /F /T /PID $proc.Id | Out-Null } catch { }
    try { $proc.Kill() } catch { }
    Start-Sleep -Milliseconds 120
  }
  try { if (-not $proc.HasExited) { $null = $proc.WaitForExit(3000) } } catch { }
  try { if (-not $proc.HasExited) { $proc.Kill(); Start-Sleep -Milliseconds 80 } } catch { }

  $exitCode = -1
  try {
    $exitCode = $proc.ExitCode
    if ($null -eq $exitCode) { $exitCode = 0 }
  } catch { $exitCode = -1 }

  return @{ exitCode = $exitCode; timedOut = $timedOut; peakMemoryBytes = $peakBytes; durationMs = $durMs; errMsg = $errMsg }
}

# Batch mode: run every job inside this single PowerShell process
if ($job.jobs) {
  $results = New-Object System.Collections.ArrayList
  foreach ($one in $job.jobs) {
    [void]$results.Add((Invoke-JudgeJob $one))
  }
  @{ results = $results } | ConvertTo-Json -Depth 5 | Out-File -LiteralPath $ResultFile -Encoding utf8
  exit 0
}

# Single job mode (legacy callers)
$r = Invoke-JudgeJob $job
$r | ConvertTo-Json | Out-File -LiteralPath $ResultFile -Encoding utf8
