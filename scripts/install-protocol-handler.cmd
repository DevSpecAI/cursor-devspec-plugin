@echo off
cd /d "%~dp0.."
node scripts\open-handler.mjs --install
echo.
echo DevSpec devspec:// protocol handler installed.
echo Click the rocket on devspec.ai — allow the browser prompt on first use.
pause
