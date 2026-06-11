@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if not %errorlevel%==0 (
  echo Node.js was not found. Please install Node.js 18 or newer first.
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', 8800); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not %errorlevel%==0 (
  echo Starting AI Manga Drama Workbench...
  start "AI Manga Drama Workbench" cmd /k "cd /d ""%~dp0"" && npm start"
  timeout /t 3 /nobreak >nul
) else (
  echo AI Manga Drama Workbench is already running.
)

start "" "http://127.0.0.1:8800/"

if not exist "tools\runway-bridge\bridge.js" (
  echo Runway Bridge was not found at tools\runway-bridge.
  pause
  exit /b 1
)

echo Starting Runway Bridge worker...
echo Keep the Runway Bridge window open while runway-bridge video tasks are queued.
start "Runway Bridge Worker" cmd /k "cd /d ""%~dp0tools\runway-bridge"" && if not exist node_modules npm install && npm start"

echo.
echo Workbench URL: http://127.0.0.1:8800/
echo If Runway asks you to log in, finish login in the Chrome window opened by the bridge.
pause
