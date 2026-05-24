@echo off
REM Video Grabber - one-click setup
REM Double-click this file. No PowerShell knowledge needed.

setlocal
title Video Grabber setup

echo.
echo  ============================================
echo   Video Grabber - one-click setup
echo  ============================================
echo.
echo  This will install:
echo    - ffmpeg     (rewraps .ts videos to .mp4)
echo    - yt-dlp     (lets YouTube and 1500+ other sites work)
echo    - Python     (runs the helper that talks to yt-dlp)
echo.
echo  And register a background task so .ts files auto-convert to .mp4.
echo.
echo  Press any key to start, or close this window to cancel.
pause >nul

REM Run the PowerShell setup with execution policy bypassed for this session.
REM -NoProfile keeps it fast.  -ExecutionPolicy Bypass means no fiddling with
REM Set-ExecutionPolicy is needed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Setup-TsWatcher.ps1"
set RC=%ERRORLEVEL%

echo.
if %RC% NEQ 0 (
  echo  Setup ended with errors. Scroll up to see what happened.
) else (
  echo  ============================================
  echo   Setup complete!
  echo  ============================================
  echo.
  echo  Next steps to load the extension:
  echo    1. Open Edge or Chrome
  echo    2. Go to:  edge://extensions/   (or chrome://extensions/)
  echo    3. Toggle  Developer mode  ON  (top right)
  echo    4. Click   Load unpacked
  echo    5. Pick the  dist  folder inside this repo
  echo    6. Pin the extension to the toolbar
  echo.
  echo  Open a tab with a video, click the extension icon, done.
)

echo.
echo  Press any key to close this window.
pause >nul
endlocal
