@echo off
title Put the song requests app online (Cloudflare)
rem Double-click to put the app online on Cloudflare, or to publish the latest changes.
rem Safe to run again any time.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get the LTS version from https://nodejs.org, then try again.
  echo.
  pause
  exit /b 1
)

rem Get the latest version first, if this folder was set up with git.
if exist ".git" (
  where git >nul 2>nul
  if not errorlevel 1 (
    echo   Checking for updates...
    git pull --ff-only
    echo.
  )
)

rem Cloudflare's command-line tool (wrangler), installed into this folder the first time.
if not exist "node_modules\wrangler" (
  echo   Installing Cloudflare's tool, this takes a minute the first time...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Installing failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

node tools\deploy-cloudflare.mjs

echo.
pause
