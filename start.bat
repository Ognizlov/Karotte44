@echo off
cd /d "%~dp0"
if not exist node_modules call npm.cmd install
start "" cmd /c "timeout /t 5 >nul & start http://localhost:3000"
node src\index.js
pause
