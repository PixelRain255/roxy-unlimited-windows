@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-webui.ps1" -Background %*
if errorlevel 1 pause
endlocal
