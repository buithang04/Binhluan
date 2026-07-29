@echo off
set "PATH=C:\binhluan\tools\nodejs;%PATH%"
cd /d "%~dp0"

pm2 stop binhluan 2>nul
pm2 delete binhluan 2>nul
pm2 save 2>nul

echo.
echo  Da dung Binhluan (PM2).
echo.
pause
