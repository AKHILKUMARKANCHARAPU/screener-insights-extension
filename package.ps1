# package.ps1 — builds a clean, store-ready zip of the extension.
# Includes ONLY the runtime files (no .git, no scripts, no dev cruft).
# Usage:  powershell -ExecutionPolicy Bypass -File package.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Read version from manifest so the zip name always matches.
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version  = $manifest.version
$zipName  = "screener-insights-v$version.zip"
$zipPath  = Join-Path $root $zipName

# Files / folders that ship in the extension.
$include = @('manifest.json', 'README.md', 'LICENSE', 'src', 'styles', 'lib', 'icons')

# Stage into a temp folder so the zip has clean top-level contents.
$stage = Join-Path $env:TEMP "si-pkg-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($item in $include) {
  $srcPath = Join-Path $root $item
  if (Test-Path $srcPath) {
    Copy-Item $srcPath -Destination $stage -Recurse
  } else {
    Write-Warning "Skipping missing item: $item"
  }
}

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath
Remove-Item $stage -Recurse -Force

$sizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "Built $zipName ($sizeKb KB)" -ForegroundColor Green
