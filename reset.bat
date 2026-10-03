@echo off
rem ============================================================================
rem  LCZOJ reset launcher (Windows)
rem
rem  This file must stay ASCII-only: cmd.exe reads .bat files using the console
rem  code page, so multibyte (Chinese) text inside a .bat can corrupt batch
rem  parsing. All messages are printed by deploy\reset.js instead.
rem
rem  Usage:
rem    reset.bat               stop service and clear data (asks for confirmation)
rem    reset.bat --yes         no confirmation
rem    reset.bat --check       show planned actions only, change nothing
rem    reset.bat --start       clear data then start in this window
rem    reset.bat --daemon      clear data then start in background
rem    reset.bat --port 8080   use another port
rem    reset.bat --help        show full help (Chinese)
rem ============================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [LCZOJ] Node.js not found. Install Node.js 22.5+ ^(v24 recommended^) and retry.
  echo         Download: https://nodejs.org/zh-cn/download
  endlocal
  exit /b 1
)

node "deploy\reset.js" %*
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
