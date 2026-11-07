<#
.SYNOPSIS
  Removes the Imagine Review panel from Resolve and its MCP entry from Cursor, and stops the service.
  Review notes in episode folders (review/) are never touched. -Purge also deletes %APPDATA%\ImagineReview.
#>
param([switch]$Purge)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$serviceDir = Join-Path $root "service"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if ($node -and (Test-Path (Join-Path $serviceDir "dist\cli.js"))) {
    Push-Location $serviceDir
    & $node dist/cli.js stop
    & $node tools/register-mcp.mjs --remove
    Pop-Location
}
$pluginDst = Join-Path $env:ProgramData "Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\com.imagine.review"
if (Test-Path $pluginDst) { Remove-Item -Recurse -Force $pluginDst; Write-Host "removed $pluginDst" }
if ($Purge) {
    $app = Join-Path $env:APPDATA "ImagineReview"
    if (Test-Path $app) { Remove-Item -Recurse -Force $app; Write-Host "removed $app" }
}
Write-Host "Restart DaVinci Resolve to drop the panel from the Workflow Integrations menu."
