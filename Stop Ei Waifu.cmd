@echo off
rem Quits Ei Waifu completely. The character disappears and the tray icon goes away.
setlocal
set "EXE=%~dp0src-tauri\target\release\ei-waifu.exe"

rem The app closes itself when it gets this flag.
if exist "%EXE%" start "" "%EXE%" --quit

rem Safety net in case a copy is stuck.
ping -n 3 127.0.0.1 >nul
taskkill /IM ei-waifu.exe /F >nul 2>&1
endlocal
