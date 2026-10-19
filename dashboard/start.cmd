@echo off
rem Double-click to start the dashboard and open it in your browser.
cd /d "%~dp0.."
node dashboard\server.js --open
if errorlevel 1 pause
