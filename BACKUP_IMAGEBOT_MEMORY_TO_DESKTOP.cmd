@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\EXPORT_IMAGEBOT_MEMORY_DESKTOP_BACKUP.ps1"
pause
