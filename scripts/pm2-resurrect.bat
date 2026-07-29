@echo off
REM Tu dong khoi dong khi dang nhap Windows (Startup shortcut)
set "PATH=C:\binhluan\tools\nodejs;%PATH%"
set "BINHLUAN_NODE=C:\binhluan\tools\nodejs\node.exe"
cd /d "%~dp0.."

docker compose up -d >nul 2>&1
timeout /t 20 /nobreak >nul
pm2 resurrect >nul 2>&1
if errorlevel 1 (
  node scripts/pm2-start.mjs >nul 2>&1
  pm2 save >nul 2>&1
)
