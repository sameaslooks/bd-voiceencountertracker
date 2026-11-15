@echo off
setlocal
cd /d "%~dp0"

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
set "NEED_INSTALL="

if not exist "%ELECTRON%" set "NEED_INSTALL=1"
if not exist "%~dp0node_modules\pngjs\package.json" set "NEED_INSTALL=1"

if defined NEED_INSTALL (
    where npm >nul 2>nul
    if errorlevel 1 (
        echo [VoiceEncounterTracker] Dependencies are missing and npm was not found.
        echo Install Node.js from https://nodejs.org/ and run this file again.
        pause
        exit /b 1
    )
    echo [VoiceEncounterTracker] Installing overlay dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [VoiceEncounterTracker] npm install failed.
        pause
        exit /b 1
    )
)

if not exist "%ELECTRON%" (
    echo [VoiceEncounterTracker] Electron is still missing after install: %ELECTRON%
    pause
    exit /b 1
)

start "" "%ELECTRON%" "%~dp0overlay-app.js"
exit /b 0
