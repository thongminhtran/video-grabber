@echo off
REM Video Grabber - one-click uninstall

setlocal
title Video Grabber uninstall

echo.
echo  ============================================
echo   Video Grabber - uninstall
echo  ============================================
echo.
echo  This will remove:
echo    - The .ts to .mp4 background watcher (scheduled task)
echo    - The native messaging host (so YouTube downloads stop working)
echo    - Registry entries for Edge and Chrome
echo.
echo  Things this will NOT touch:
echo    - The extension itself (remove via edge://extensions/)
echo    - Your video files in Downloads\Private or anywhere else
echo    - ffmpeg / yt-dlp / Python (use 'winget uninstall' if you want)
echo.
echo  Press any key to continue, or close this window to cancel.
pause >nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Uninstall-TsWatcher.ps1"

echo.
echo  Press any key to close.
pause >nul
endlocal
