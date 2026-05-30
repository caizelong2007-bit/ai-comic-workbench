@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', 8800); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if %errorlevel%==0 (
  echo AI Manga Drama Workbench is already running.
  start "" "http://127.0.0.1:8800/"
  pause
  exit /b 0
)

where node >nul 2>nul
if not %errorlevel%==0 (
  echo Node.js was not found. Please install Node.js 18 or newer first.
  pause
  exit /b 1
)

echo Starting AI Manga Drama Workbench...
echo URL: http://127.0.0.1:8800/
start "" "http://127.0.0.1:8800/"

npm start

pause
