@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%open-bridge.mjs" --force
if errorlevel 1 (
  echo DevSpec open bridge failed to start.
  exit /b 1
)
echo DevSpec open bridge is running on http://127.0.0.1:42731/open
endlocal
