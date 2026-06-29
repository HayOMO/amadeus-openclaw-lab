@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0STOP_IMAGEBOT_GATEWAY.ps1"
if errorlevel 1 pause
