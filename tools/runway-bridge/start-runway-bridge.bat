@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo Installing Runway Bridge dependencies...
  npm install
)

echo Starting Runway Bridge...
echo Workbench: %WORKBENCH_URL%
npm start

pause
