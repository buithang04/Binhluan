# Tao thu muc uploads + danh sach anh can copy tu may cu
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$uploads = Join-Path $root "uploads"
New-Item -ItemType Directory -Force -Path $uploads | Out-Null

$sql = @'
SELECT "projectId", "fileName", "sizeBytes"
FROM "MediaAsset"
ORDER BY "projectId", "fileName";
'@

$rows = $sql | docker exec -i automation-profile-manager-postgres-1 psql -U apm -d apm -t -A -F '|' 2>$null
if (-not $rows) {
  Write-Host "Loi: Docker/Postgres chua chay." -ForegroundColor Red
  exit 1
}

$manifest = @()
foreach ($line in $rows) {
  if (-not $line.Trim()) { continue }
  $parts = $line.Split('|')
  if ($parts.Count -lt 2) { continue }
  $projectId, $fileName = $parts[0], $parts[1]
  $dir = Join-Path $uploads $projectId
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $dest = Join-Path $dir $fileName
  $manifest += [PSCustomObject]@{
    ProjectId = $projectId
    FileName  = $fileName
    Dest      = $dest
    Exists    = (Test-Path $dest)
  }
}

$missing = $manifest | Where-Object { -not $_.Exists }
$csv = Join-Path $root "database\media-manifest.csv"
$manifest | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8

Write-Host ""
Write-Host "=== UPLOADS ===" -ForegroundColor Cyan
Write-Host "Thu muc: $uploads"
Write-Host "Tong anh trong DB: $($manifest.Count)"
Write-Host "Co file tren disk: $(($manifest | Where-Object Exists).Count)"
Write-Host "Thieu: $($missing.Count)"
Write-Host "Manifest: $csv"
Write-Host ""
if ($missing.Count -gt 0) {
  Write-Host "Copy tu may cu (vi du D:\Binhluangooglemaps\uploads) vao:" -ForegroundColor Yellow
  Write-Host "  $uploads\<projectId>\<fileName>.jpg"
  Write-Host ""
  Write-Host "Hoac chay (sua duong dan nguon):" -ForegroundColor Yellow
  Write-Host "  robocopy D:\Binhluangooglemaps\uploads $uploads /E"
}
