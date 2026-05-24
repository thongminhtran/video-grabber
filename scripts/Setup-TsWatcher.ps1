param(
  [string]$WatchPath = (Join-Path $env:USERPROFILE "Downloads\Private"),
  [string]$TaskName  = "VideoGrabber-TsToMp4-Watcher",
  [string]$ExtensionId = "mhdhnnnflfgdemljlgeoladambdopldk",
  [string]$NativeHostName = "com.videograbber.helper",
  [switch]$SkipNativeHost,
  [switch]$SkipWatcher
)

$ErrorActionPreference = "Stop"

Write-Host "=== Video Grabber setup ===" -ForegroundColor Cyan
Write-Host ""

# 1) Watch folder
if (-not (Test-Path -LiteralPath $WatchPath)) {
  Write-Host "Creating folder: $WatchPath"
  New-Item -ItemType Directory -Path $WatchPath -Force | Out-Null
} else {
  Write-Host "Watch folder: $WatchPath"
}

# 2) ffmpeg (for .ts -> .mp4 watcher)
if (-not $SkipWatcher) {
  $ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  if (-not $ffmpeg) {
    Write-Host ""
    Write-Host "ffmpeg not found. Installing via winget (Gyan.FFmpeg)..." -ForegroundColor Yellow
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
      throw "winget not found. Install ffmpeg manually from https://www.gyan.dev/ffmpeg/builds/ and add to PATH."
    }
    & winget install --id=Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if (-not $ffmpeg) {
      Write-Host "ffmpeg installed but not on PATH for this session. Close + reopen terminal, then re-run this script." -ForegroundColor Yellow
      exit 1
    }
  }
  Write-Host "ffmpeg: $($ffmpeg.Source)" -ForegroundColor Green
}

# 3) yt-dlp (for YouTube and ~1500 other sites)
if (-not $SkipNativeHost) {
  $ytdlp = Get-Command yt-dlp.exe -ErrorAction SilentlyContinue
  if (-not $ytdlp) {
    Write-Host ""
    Write-Host "yt-dlp not found. Installing via winget..." -ForegroundColor Yellow
    & winget install --id=yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $ytdlp = Get-Command yt-dlp.exe -ErrorAction SilentlyContinue
    if (-not $ytdlp) {
      Write-Host "yt-dlp installed but not on PATH for this session. Close + reopen terminal, then re-run." -ForegroundColor Yellow
      exit 1
    }
  }
  Write-Host "yt-dlp: $($ytdlp.Source)" -ForegroundColor Green
}

# 4) Python (for native host)
if (-not $SkipNativeHost) {
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $python) {
    Write-Host ""
    Write-Host "Python not found. Installing Python 3.12 via winget..." -ForegroundColor Yellow
    & winget install --id=Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $python) {
      Write-Host "Python installed but not on PATH for this session. Close + reopen terminal, then re-run." -ForegroundColor Yellow
      exit 1
    }
  }
  Write-Host "python: $($python.Source)" -ForegroundColor Green
}

# 5) Watcher: scheduled task
if (-not $SkipWatcher) {
  $scriptPath = Join-Path $PSScriptRoot "Convert-TsWatcher.ps1"
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Cannot find Convert-TsWatcher.ps1 (expected: $scriptPath)"
  }

  Write-Host ""
  Write-Host "Registering scheduled task: $TaskName" -ForegroundColor Cyan
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" -WatchPath `"{1}`"" -f $scriptPath, $WatchPath)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Auto-converts .ts files in Downloads\Private to .mp4 (lossless rewrap)." | Out-Null

  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $task = Get-ScheduledTask -TaskName $TaskName
  Write-Host ("Watcher state: {0}, LastRunTime: {1}" -f $task.State, $info.LastRunTime) -ForegroundColor Green
}

# 6) Native messaging host registration
if (-not $SkipNativeHost) {
  Write-Host ""
  Write-Host "Registering native messaging host: $NativeHostName" -ForegroundColor Cyan

  $runBat = Join-Path (Split-Path -Parent $PSScriptRoot) "native-host\run.bat"
  $helperPy = Join-Path (Split-Path -Parent $PSScriptRoot) "native-host\helper.py"
  if (-not (Test-Path -LiteralPath $runBat))   { throw "Missing $runBat" }
  if (-not (Test-Path -LiteralPath $helperPy)) { throw "Missing $helperPy" }

  $manifestDir = Join-Path $env:APPDATA "VideoGrabber"
  if (-not (Test-Path -LiteralPath $manifestDir)) {
    New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null
  }
  $manifestPath = Join-Path $manifestDir "$NativeHostName.json"

  $manifest = [ordered]@{
    name = $NativeHostName
    description = "Video Grabber native host (yt-dlp wrapper)"
    path = $runBat
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
  }
  ($manifest | ConvertTo-Json -Depth 5) | Out-File -FilePath $manifestPath -Encoding utf8 -Force
  Write-Host "Manifest: $manifestPath" -ForegroundColor Green

  $browsers = @(
    @{ Name = "Edge"   ; Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$NativeHostName" },
    @{ Name = "Chrome" ; Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NativeHostName" }
  )
  foreach ($b in $browsers) {
    if (-not (Test-Path $b.Key)) { New-Item -Path $b.Key -Force | Out-Null }
    Set-ItemProperty -Path $b.Key -Name "(default)" -Value $manifestPath
    Write-Host "  registered: $($b.Name) -> $($b.Key)"
  }

  Write-Host "Allowed extension origin: chrome-extension://$ExtensionId/" -ForegroundColor Gray
  Write-Host "If your extension ID differs (you can see it at edge://extensions/), re-run with:"
  Write-Host "  .\Setup-TsWatcher.ps1 -ExtensionId YOUR_ID_HERE"
}

Write-Host ""
Write-Host "All done." -ForegroundColor Cyan
Write-Host "Log file: $(Join-Path $WatchPath '.ts-watcher.log')" -ForegroundColor Gray
