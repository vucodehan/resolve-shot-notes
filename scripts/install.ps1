<#
.SYNOPSIS
  Installs Imagine Review: the DaVinci Resolve panel, its background service, and the Cursor MCP link.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -ProjectsRoot "$env:USERPROFILE\projects" -PipelineDoc "$env:USERPROFILE\projects\pipeline.md"

.NOTES
  Needs DaVinci Resolve Studio 21.0.4 or later (Workflow Integration plugins and Timeline.GetSelectedClips),
  Node.js 22.13 or later, ffmpeg, and a Python that can import DaVinciResolveScript. Safe to re-run.
#>
param(
    [string]$ProjectsRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$PipelineDoc = "",
    [string]$Python = "",
    [string]$Model = "",
    [switch]$SkipSignIn,
    [switch]$NoMcp
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$serviceDir = Join-Path $root "service"
$pluginSrc = Join-Path $root "plugin\com.imagine.review"
$resolveSupport = Join-Path $env:ProgramData "Blackmagic Design\DaVinci Resolve\Support"
$pluginRoot = Join-Path $resolveSupport "Workflow Integration Plugins"
$pluginDst = Join-Path $pluginRoot "com.imagine.review"
$wiNode = Join-Path $resolveSupport "Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node"
$scriptApi = Join-Path $resolveSupport "Developer\Scripting"
$scriptLib = "C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll"

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "   $t" -ForegroundColor Yellow }

Step "Checking prerequisites"
$resolveExe = "C:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe"
if (-not (Test-Path $resolveExe)) { throw "DaVinci Resolve is not installed at $resolveExe." }
$rv = [version]((Get-Item $resolveExe).VersionInfo.ProductVersion -replace '[^\d.].*$', '')
if ($rv -lt [version]"21.0.4") { throw "DaVinci Resolve $rv found; Imagine Review needs Studio 21.0.4 or later." }
Ok "DaVinci Resolve $rv"
if (-not (Test-Path $wiNode)) { throw "Resolve's Workflow Integration module is missing ($wiNode). Is this DaVinci Resolve Studio?" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js is not on PATH. Install Node 22.13 or later from https://nodejs.org." }
$nv = [version]((& $node --version).TrimStart('v'))
if ($nv -lt [version]"22.13") { throw "Node $nv found; the Cursor SDK needs 22.13 or later." }
Ok "Node $nv ($node)"

$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg -and (Test-Path "C:\FFmpeg\bin\ffmpeg.exe")) { $ffmpeg = "C:\FFmpeg\bin\ffmpeg.exe" }
if (-not $ffmpeg) { throw "ffmpeg was not found (PATH or C:\FFmpeg\bin). It pulls the frame stills for each note." }
$ffprobe = Join-Path (Split-Path $ffmpeg) "ffprobe.exe"
Ok "ffmpeg ($ffmpeg)"

$env:RESOLVE_SCRIPT_API = $scriptApi
$env:RESOLVE_SCRIPT_LIB = $scriptLib
$env:PYTHONPATH = Join-Path $scriptApi "Modules"
$candidates = @($Python, "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe", "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe", (Get-Command python -ErrorAction SilentlyContinue).Source) | Where-Object { $_ -and (Test-Path $_) }
$py = $null
foreach ($c in $candidates) {
    & $c -c "import DaVinciResolveScript" 2>$null
    if ($LASTEXITCODE -eq 0) { $py = $c; break }
}
if ($py) { Ok "Python for harvesting ($py)" } else { Warn "No Python could import DaVinciResolveScript; 'harvest' from Cursor will not work (the panel still does)."; $py = "python" }

if (-not (Test-Path $ProjectsRoot)) { throw "Projects folder not found: $ProjectsRoot (pass -ProjectsRoot)." }
if (-not $PipelineDoc) {
    $doc = Get-ChildItem -Path $ProjectsRoot -Filter "strategypipeline*.md" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($doc) { $PipelineDoc = $doc.FullName }
}
Ok "Projects: $ProjectsRoot"
if ($PipelineDoc) { Ok "Pipeline: $PipelineDoc" } else { Warn "No pipeline document; the repair agent will work from the episode files alone." }

Step "Building the service"
Push-Location $serviceDir
try {
    & npm install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    & npx tsc -p tsconfig.json
    if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed" }
} finally { Pop-Location }
Ok "service\dist built"

Step "Writing the configuration"
$cfgArgs = @("tools/configure.mjs", "--projects", $ProjectsRoot, "--python", $py, "--node", $node, "--ffmpeg", $ffmpeg, "--ffprobe", $ffprobe)
if ($PipelineDoc) { $cfgArgs += @("--pipeline", $PipelineDoc) }
if ($Model) { $cfgArgs += @("--model", $Model) }
Push-Location $serviceDir
try { & $node @cfgArgs | Out-Host } finally { Pop-Location }

Step "Installing the panel into DaVinci Resolve"
New-Item -ItemType Directory -Force -Path $pluginDst | Out-Null
Copy-Item -Path (Join-Path $pluginSrc "*") -Destination $pluginDst -Recurse -Force
Copy-Item -Path $wiNode -Destination (Join-Path $pluginDst "WorkflowIntegration.node") -Force
Ok $pluginDst

if (-not $NoMcp) {
    Step "Linking Cursor (MCP server 'imagine-review')"
    Push-Location $serviceDir
    try { & $node tools/register-mcp.mjs --node $node | Out-Host } finally { Pop-Location }
}

Step "Starting the service"
$entry = Join-Path $serviceDir "dist\index.js"
$cfg = Get-Content (Join-Path $env:APPDATA "ImagineReview\config.json") -Raw | ConvertFrom-Json
$up = $false
try { Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/api/health" -Headers @{ "x-imagine-token" = $cfg.token } -TimeoutSec 2 | Out-Null; $up = $true } catch { }
if (-not $up) {
    Start-Process -FilePath $node -ArgumentList "`"$entry`"" -WindowStyle Hidden
    for ($i = 0; $i -lt 30 -and -not $up; $i++) {
        Start-Sleep -Milliseconds 500
        try { Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/api/health" -Headers @{ "x-imagine-token" = $cfg.token } -TimeoutSec 2 | Out-Null; $up = $true } catch { }
    }
}
if ($up) { Ok "running on 127.0.0.1:$($cfg.port)" } else { Warn "the service did not answer; see %APPDATA%\ImagineReview\logs\service.log" }

if (-not $SkipSignIn) {
    Step "Cursor sign-in"
    Push-Location $serviceDir
    try { & $node tools/sign-in.mjs | Select-Object -First 2 | Out-Host } finally { Pop-Location }
}

Step "Done"
Write-Host @"
   Restart DaVinci Resolve once, then open Workspace > Workflow Integrations > Imagine Review.
   In Cursor, the 'imagine-review' MCP server appears under Settings > MCP (reload the window if it does not).
"@
