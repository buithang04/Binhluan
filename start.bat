@echo off
cd /d "%~dp0"

REM Khoi dong cua so CMD rieng, khong phu thuoc Cursor/IDE
start "Binhluan" cmd /k "%~dp0run-dev.bat"
exit /b 0
