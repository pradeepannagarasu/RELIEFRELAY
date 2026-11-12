# Copies the source (without node_modules, build output, .env, local Cloudflare secrets or any database) and a full-history git bundle to a backup folder, such as a synced Google Drive folder.
# Google Drive cannot host node_modules, so development happens on local disk and Drive holds the backup.
# Usage: powershell -File scripts/backup-to-drive.ps1 -Destination '<backup folder>'
param(
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Force $Destination | Out-Null }

robocopy $repo (Join-Path $Destination 'source') /MIR /XD node_modules dist coverage .git .wrangler (Join-Path $repo 'server\data') /XF .env .dev.vars* *.log *.db *.db-wal *.db-shm *.db-journal /NFL /NDL /NJH /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

$bundle = Join-Path $env:TEMP 'reliefrelay.bundle'
git -C $repo bundle create $bundle --all
if ($LASTEXITCODE -ne 0) { throw 'git bundle failed' }
Copy-Item $bundle (Join-Path $Destination 'reliefrelay.bundle') -Force
Remove-Item $bundle

Write-Host "Backed up source and git bundle to $Destination"
Write-Host "Restore with: git clone `"$Destination\reliefrelay.bundle`" ReliefRelay"
