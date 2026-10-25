@echo off
rem Starts the Wolfie Butler site on this computer only: http://localhost:5500/index.html
rem Does not start the agent and does not publish anything. Stop it with Ctrl+C or by closing this window.
cd /d "%~dp0"
title Wolfie Butler - local site
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
node local-server.mjs 5500
echo.
echo The local site has stopped.
pause
