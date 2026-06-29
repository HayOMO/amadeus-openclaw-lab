@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0RESTART_IMAGEBOT_GATEWAY.ps1"
if errorlevel 1 pause
