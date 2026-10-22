@echo off
rem Starts Ei Waifu.
rem
rem When she is already running the running copy is brought back to the
rem screen instead of starting a second character on the desktop.
setlocal
set "EXE=%~dp0src-tauri\target\release\ei-waifu.exe"

if not exist "%EXE%" (
  echo Ei Waifu is not built yet.
  echo Build it with:  npm run tauri build
  echo.
  pause
  exit /b 1
)

start "" "%EXE%"
endlocal
