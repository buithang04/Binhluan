@echo off
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Binhluan.lnk"
if exist "%LINK%" del "%LINK%"
echo Da go autostart Binhluan.
pause
