@echo off
rem Hides the running Ei Waifu character without quitting the app.
rem She can be brought back from the tray icon or by running Start Ei Waifu.cmd again.
setlocal
set "EXE=%~dp0src-tauri\target\release\ei-waifu.exe"

if not exist "%EXE%" (
  echo Ei Waifu is not built yet.
  echo Build it with:  npm run tauri build
  echo.
  pause
  exit /b 1
)

start "" "%EXE%" --hide
endlocal
