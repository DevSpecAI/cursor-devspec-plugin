@echo off
setlocal
set "DIR=%~dp0"
set "HANDLER=%DIR%open-handler.mjs"
set "EXE=%DIR%bin\devspec-open-handler.exe"

where node >nul 2>&1
if %ERRORLEVEL%==0 (
  node "%HANDLER%" --url %1
  exit /b %ERRORLEVEL%
)

if exist "%EXE%" (
  "%EXE%" --url %1
  exit /b %ERRORLEVEL%
)

echo DevSpec handler requires Node.js or devspec-open-handler.exe>&2
exit /b 1
