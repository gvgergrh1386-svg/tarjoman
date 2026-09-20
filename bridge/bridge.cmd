@echo off
rem ---------------------------------------------------------------------------
rem  Tarjoman Bridge - launcher
rem
rem  Double-click this file. It finds a Python, runs the bridge, and leaves the
rem  window open so the token stays readable and Ctrl+C still works.
rem
rem  THIS FILE IS DELIBERATELY PURE ASCII, WITH CRLF LINE ENDINGS.
rem  Both are load-bearing, and getting either wrong destroys the launcher in a
rem  way that reads as nonsense rather than as an error:
rem
rem   * cmd.exe re-opens a batch file and SEEKS BY BYTE OFFSET after every
rem     command. Multi-byte UTF-8 text, or LF-only line endings, desynchronise
rem     that seek, so it resumes mid-line and runs fragments. That is all the
rem     'on.exe' / 'elf' / 'just' / 'sion' is not recognized noise ever was.
rem
rem   * A non-ASCII PATH is worse than cosmetic: written here as UTF-8 and read
rem     back under the console's legacy code page, D:\<persian>\... becomes a
rem     directory that does not exist, so the interpreter is never found.
rem
rem  So: no Persian in this file, and no hard-coded Persian path. The banner is
rem  printed by Python, which handles its own encoding, and picking the best
rem  interpreter happens in bridge.py, where a path is just a string.
rem ---------------------------------------------------------------------------
title Tarjoman Bridge
cd /d "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY where python >nul 2>nul && set "PY=python"

if not defined PY (
  echo.
  echo   Python was not found on this computer.
  echo   Install it from python.org, then open this file again.
  echo.
  pause
  exit /b 1
)

"%PY%" "%~dp0bridge.py" %*
set "RC=%ERRORLEVEL%"

rem Only pause on a failure; a clean Ctrl+C should just close.
if not "%RC%"=="0" (
  echo.
  echo   The bridge exited with code %RC%.
  pause
)
exit /b %RC%
