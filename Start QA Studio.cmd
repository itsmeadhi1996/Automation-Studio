@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart QA Studio.ps1" -UpgradeOnly
if errorlevel 1 pause
