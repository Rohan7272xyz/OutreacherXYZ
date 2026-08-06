@echo off
rem Double-click me to start OutreacherXYZ (Windows)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   OutreacherXYZ needs Node.js, which isn't installed yet.
  echo   Opening the download page - install the LTS version, then run me again.
  echo.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
node app\server.js
pause
