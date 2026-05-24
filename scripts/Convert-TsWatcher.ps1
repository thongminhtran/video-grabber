param(
  [string]$WatchPath = (Join-Path $env:USERPROFILE "Downloads\Private"),
  [string]$LogPath  = (Join-Path $env:USERPROFILE "Downloads\Private\.ts-watcher.log"),
  [switch]$DeleteOriginal = $true
)

$ErrorActionPreference = "Continue"

function Write-Log {
  param([string]$Message)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$ts] $Message"
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8 } catch {}
  Write-Host $line
}

function Find-Ffmpeg {
  $cmd = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles "ffmpeg\bin\ffmpeg.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "ffmpeg\bin\ffmpeg.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\ffmpeg.exe")
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  $globs = @(
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials_*\ffmpeg-*\bin\ffmpeg.exe")
  )
  foreach ($g in $globs) {
    $hit = Get-Item -Path $g -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Wait-ForStableFile {
  param([string]$Path, [int]$TimeoutSec = 1800)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $lastSize = -1
  $stableCount = 0
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
      $stream = [System.IO.File]::Open($Path, "Open", "Read", "None")
      $stream.Close()
      $size = (Get-Item -LiteralPath $Path).Length
      if ($size -gt 0 -and $size -eq $lastSize) {
        $stableCount++
        if ($stableCount -ge 2) { return $true }
      } else {
        $stableCount = 0
        $lastSize = $size
      }
    } catch {
      $stableCount = 0
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Convert-One {
  param([string]$TsPath)
  if (-not (Test-Path -LiteralPath $TsPath)) { return }
  Write-Log "queued: $TsPath"
  if (-not (Wait-ForStableFile -Path $TsPath)) {
    Write-Log "skip (not stable in time): $TsPath"
    return
  }

  $mp4Path = [System.IO.Path]::ChangeExtension($TsPath, ".mp4")
  if (Test-Path -LiteralPath $mp4Path) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($mp4Path)
    $dir  = [System.IO.Path]::GetDirectoryName($mp4Path)
    $i = 1
    while (Test-Path -LiteralPath (Join-Path $dir ("{0} ({1}).mp4" -f $base, $i))) { $i++ }
    $mp4Path = Join-Path $dir ("{0} ({1}).mp4" -f $base, $i)
  }

  Write-Log "convert: $TsPath -> $mp4Path"
  $ffArgs = @(
    "-y", "-hide_banner", "-loglevel", "error",
    "-fflags", "+genpts",
    "-i", $TsPath,
    "-c", "copy",
    "-bsf:a", "aac_adtstoasc",
    "-movflags", "+faststart",
    $mp4Path
  )

  $stderr = & $script:Ffmpeg @ffArgs 2>&1
  $exit = $LASTEXITCODE
  if ($stderr) { $stderr | ForEach-Object { Write-Log "ffmpeg: $_" } }

  if ($exit -eq 0 -and (Test-Path -LiteralPath $mp4Path) -and ((Get-Item -LiteralPath $mp4Path).Length -gt 0)) {
    $mb = [Math]::Round((Get-Item -LiteralPath $mp4Path).Length / 1MB, 1)
    Write-Log "done: $mp4Path ($mb MB)"
    if ($DeleteOriginal) {
      try {
        Remove-Item -LiteralPath $TsPath -Force
        Write-Log "deleted .ts: $TsPath"
      } catch {
        Write-Log "could not delete .ts: $_"
      }
    }
  } else {
    Write-Log "FAIL (exit $exit): $TsPath - keeping original"
    if (Test-Path -LiteralPath $mp4Path) {
      try { Remove-Item -LiteralPath $mp4Path -Force } catch {}
    }
  }
}

# --- main ---

if (-not (Test-Path -LiteralPath $WatchPath)) {
  New-Item -ItemType Directory -Path $WatchPath -Force | Out-Null
}

$script:Ffmpeg = Find-Ffmpeg
if (-not $script:Ffmpeg) {
  Write-Log "ERROR: ffmpeg not found. Run Setup-TsWatcher.ps1 to install it."
  exit 1
}

Write-Log "===== watcher start ====="
Write-Log "watching: $WatchPath"
Write-Log "ffmpeg : $script:Ffmpeg"
Write-Log "delete-original: $DeleteOriginal"

Get-ChildItem -LiteralPath $WatchPath -Filter "*.ts" -File -ErrorAction SilentlyContinue | ForEach-Object {
  Convert-One -TsPath $_.FullName
}

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $WatchPath
$watcher.Filter = "*.ts"
$watcher.IncludeSubdirectories = $false
$watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::Size
$watcher.EnableRaisingEvents = $true

$queue = New-Object System.Collections.Generic.HashSet[string]
$sync  = [System.Threading.Mutex]::new()

$enqueue = {
  param($path)
  $script:sync.WaitOne() | Out-Null
  try { [void]$script:queue.Add($path) } finally { $script:sync.ReleaseMutex() }
}

$onCreated = {
  $path = $Event.SourceEventArgs.FullPath
  & $script:enqueue $path
}
$onRenamed = {
  $path = $Event.SourceEventArgs.FullPath
  & $script:enqueue $path
}

Register-ObjectEvent -InputObject $watcher -EventName "Created" -Action $onCreated | Out-Null
Register-ObjectEvent -InputObject $watcher -EventName "Renamed" -Action $onRenamed | Out-Null

Write-Log "ready"

while ($true) {
  $batch = @()
  $sync.WaitOne() | Out-Null
  try {
    if ($queue.Count -gt 0) {
      $batch = @($queue)
      $queue.Clear()
    }
  } finally { $sync.ReleaseMutex() }

  foreach ($path in $batch) {
    Convert-One -TsPath $path
  }

  Start-Sleep -Seconds 2
}
