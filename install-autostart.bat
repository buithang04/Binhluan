@echo off
setlocal
set "PATH=C:\binhluan\tools\nodejs;%PATH%"
set "ROOT=%~dp0"
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Binhluan.lnk"
set "RESURRECT=%ROOT%scripts\pm2-resurrect.bat"

echo.
echo  Cai tu dong chay Binhluan (PM2) khi dang nhap Windows...
echo.

set "BINHLUAN_NODE=C:\binhluan\tools\nodejs\node.exe"
cd /d "%ROOT%"
node scripts/pm2-start.mjs

powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%LINK%');" ^
  "$s.TargetPath = '%RESURRECT%';" ^
  "$s.WorkingDirectory = '%ROOT%';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'Binhluan PM2 - tu dong khoi dong';" ^
  "$s.Save()"

echo.
echo  Da cai autostart PM2.
echo  Shortcut: %LINK%
echo.
echo  Luu y: Bat Docker Desktop - Start when you sign in
echo  Go bo: uninstall-autostart.bat
echo.
pause
