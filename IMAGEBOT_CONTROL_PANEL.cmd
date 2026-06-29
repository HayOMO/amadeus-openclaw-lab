@echo off
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0IMAGEBOT_CONTROL_PANEL.ps1"
if errorlevel 1 pause
