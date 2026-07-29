@echo off
setlocal
set "ROOT=%~dp0"
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Binhluan.lnk"

powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%LINK%');" ^
  "$s.TargetPath = 'cmd.exe';" ^
  "$s.Arguments = '/k \"\"%ROOT%run-dev.bat\"\"';" ^
  "$s.WorkingDirectory = '%ROOT%';" ^
  "$s.Description = 'Binhluan - tu dong khoi dong khi dang nhap Windows';" ^
  "$s.Save()"

echo.
echo  Da cai tu dong chay (cua so CMD rieng).
echo  Shortcut: %LINK%
echo.
echo  Luu y: Bat Docker Desktop - Start when you sign in
echo  Go bo: uninstall-autostart.bat
echo.
pause
