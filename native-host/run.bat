@echo off
REM Native messaging host launcher for the Video Grabber extension.
REM Edge/Chrome invoke this with no console; stdio is binary-piped.

setlocal

REM Pick python: prefer python3.10/3.11 installs, fall back to PATH
set "PY="
for %%P in (
  "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
  "%ProgramFiles%\Python311\python.exe"
  "%ProgramFiles%\Python310\python.exe"
) do (
  if exist "%%~P" if not defined PY set "PY=%%~P"
)
if not defined PY (
  where python.exe >nul 2>&1 && for /f "delims=" %%P in ('where python.exe') do (
    if not defined PY set "PY=%%P"
  )
)
if not defined PY (
  echo no python found 1>&2
  exit /b 1
)

"%PY%" "%~dp0helper.py" %*
