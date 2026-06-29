@echo off
cd /d "%~dp0"
node "%~dp0imagebot-launcher.js"
if errorlevel 1 pause
