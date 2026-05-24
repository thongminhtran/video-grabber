param(
  [string]$TaskName = "VideoGrabber-TsToMp4-Watcher",
  [string]$NativeHostName = "com.videograbber.helper"
)

$ErrorActionPreference = "Continue"

Write-Host "=== Video Grabber uninstall ===" -ForegroundColor Cyan
Write-Host ""

# 1) Scheduled task
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task: $TaskName" -ForegroundColor Green
} else {
  Write-Host "No scheduled task to remove."
}

# 2) Native messaging registry entries
$browserKeys = @(
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$NativeHostName",
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NativeHostName"
)
foreach ($k in $browserKeys) {
  if (Test-Path $k) {
    Remove-Item -Path $k -Force
    Write-Host "Removed registry: $k" -ForegroundColor Green
  }
}

# 3) Native host manifest file
$manifestPath = Join-Path $env:APPDATA "VideoGrabber\$NativeHostName.json"
if (Test-Path $manifestPath) {
  Remove-Item -LiteralPath $manifestPath -Force
  Write-Host "Removed manifest: $manifestPath" -ForegroundColor Green
}
$manifestDir = Join-Path $env:APPDATA "VideoGrabber"
if ((Test-Path $manifestDir) -and -not (Get-ChildItem $manifestDir -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $manifestDir -Force
}

Write-Host ""
Write-Host "Uninstall complete." -ForegroundColor Cyan
Write-Host ""
Write-Host "Still left to do manually if you want a truly clean state:" -ForegroundColor Yellow
Write-Host "  1. Remove the extension at edge://extensions/ (click Remove)"
Write-Host "  2. Optional: uninstall ffmpeg / yt-dlp / Python via 'winget uninstall'"
Write-Host "  3. Optional: delete Downloads\Private\.ts-watcher.log and .native-host.log"
Write-Host ""
