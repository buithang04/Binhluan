@echo off
set "PATH=C:\binhluan\tools\nodejs;%PATH%"
set "BINHLUAN_NODE=C:\binhluan\tools\nodejs\node.exe"
cd /d "%~dp0"

for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match 'Wi-Fi|Ethernet' -and $_.IPAddress -notlike '169.*' -and $_.IPAddress -notlike '172.31.*' } | Select-Object -First 1).IPAddress"') do set LAN_IP=%%i
if defined LAN_IP set "LAN_APP_URL=http://%LAN_IP%:3000"

echo.
echo  Binhluan — PM2 (chay nen, tat Cursor van chay)
echo  Local: http://localhost:3000/login
if defined LAN_IP echo  LAN:   http://%LAN_IP%:3000/login
echo.

node scripts/pm2-start.mjs
pause
