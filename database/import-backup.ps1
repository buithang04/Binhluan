# Import database UTF-8 dung cach (khong qua PowerShell pipe)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backup = Join-Path $root "apm_backup.sql"
$container = "automation-profile-manager-postgres-1"

if (-not (Test-Path $backup)) {
  Write-Host "Khong tim thay $backup" -ForegroundColor Red
  exit 1
}

Write-Host "Copy backup vao container..." -ForegroundColor Cyan
docker cp $backup "${container}:/tmp/apm_backup.sql"

Write-Host "Drop + create database..." -ForegroundColor Cyan
docker exec $container psql -U apm -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'apm' AND pid <> pg_backend_pid();"
docker exec $container psql -U apm -d postgres -c "DROP DATABASE IF EXISTS apm;"
docker exec $container psql -U apm -d postgres -c "CREATE DATABASE apm OWNER apm ENCODING 'UTF8';"

Write-Host "Import (UTF-8)..." -ForegroundColor Cyan
docker exec $container psql -U apm -d apm -f /tmp/apm_backup.sql | Out-Null

Write-Host "Sua ten goi binh luan (encoding)..." -ForegroundColor Cyan
$fixSql = Join-Path $root "fix-packages-encoding.sql"
if (Test-Path $fixSql) {
  docker cp $fixSql "${container}:/tmp/fix-packages-encoding.sql"
  docker exec $container psql -U apm -d apm -f /tmp/fix-packages-encoding.sql | Out-Null
}

Write-Host "Xong. Kiem tra:" -ForegroundColor Green
docker exec $container psql -U apm -d apm -c 'SELECT COUNT(*) AS projects FROM "Project"; SELECT COUNT(*) AS media FROM "MediaAsset";'
