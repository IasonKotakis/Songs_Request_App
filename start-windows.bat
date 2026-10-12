@echo off
title Song Requests
rem Double-click this file to run the app on this computer.
rem It works from wherever the folder is, no terminal or npm needed.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or Windows can't find it.
  echo   Download the "LTS" version from https://nodejs.org, install it,
  echo   then restart your computer and double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "server.js" (
  echo.
  echo   Can't find server.js next to this file.
  echo   Keep start-windows.bat in the app folder, together with server.js and the src and public folders.
  echo.
  pause
  exit /b 1
)

rem Open the dashboard in the browser a few seconds after the app starts.
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:3000/admin"

node server.js

echo.
pause
