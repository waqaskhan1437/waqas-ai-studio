param(
    [string]$OutputDir = (Join-Path $PSScriptRoot "dist")
)

$ErrorActionPreference = "Stop"

$runnerRoot = $PSScriptRoot
$stagingRoot = Join-Path $OutputDir "portable-runner"
$zipPath = Join-Path $OutputDir "local-runner-portable.zip"
$portableServerUrl = "https://waqas-ai-studio.waqaskhan1437.workers.dev"
$portableFrontendUrl = "https://frontend-nine-jet-27.vercel.app"

Import-Module (Join-Path $PSScriptRoot "build-helpers.psm1") -Force

function Write-PortableConfig {
    $configPath = Join-Path $stagingRoot "config.txt"
    @"
# Lightweight local launcher
SERVER_URL=$portableServerUrl
FRONTEND_URL=$portableFrontendUrl
RUNNER_TOKEN=
ACCESS_TOKEN=
"@ | Set-Content -LiteralPath $configPath -Encoding ASCII
}

function Write-PortableStateFiles {
    @"
{
  "status": "not_started",
  "message": "Runner has not reported status yet.",
  "updatedAt": null,
  "currentJobId": null,
  "processedVideos": 0,
  "lastError": ""
}
"@ | Set-Content -LiteralPath (Join-Path $stagingRoot "runner-state.json") -Encoding ASCII

    @"
{
  "status": "not_started",
  "message": "Background supervisor has not reported status yet.",
  "updatedAt": null,
  "startedAt": null,
  "supervisorPid": null,
  "dashboardPid": null,
  "frontendPid": null,
  "runnerSupervisorPid": null,
  "lastError": ""
}
"@ | Set-Content -LiteralPath (Join-Path $stagingRoot "supervisor-state.json") -Encoding ASCII
}

function Write-OneClickLauncher {
    $launcherPath = Join-Path $stagingRoot "Start-Portable-Runner.bat"
    @"
@echo off
call "%~dp0Launch-Local-Runner.bat"
"@ | Set-Content -LiteralPath $launcherPath -Encoding ASCII
}
Ensure-Directory $OutputDir

Write-Step "Preparing staging folder"
if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
Ensure-Directory $stagingRoot

$itemsToCopy = @(
    "bootstrap.ps1",
    "lib",
    "install-tailscale.ps1",
    "install-startup-task.ps1",
    "Launch-Local-Runner.bat",
    "restart-local-runner.ps1",
    "run-background-supervisor.bat",
    "run-runner.bat",
    "runner.js",
    "server.js",
    "setup.bat",
    "supervisor.js",
    "update-manifest.json",
    "build-helpers.psm1"
)

foreach ($item in $itemsToCopy) {
    $source = Join-Path $runnerRoot $item
    if (-not (Test-Path -LiteralPath $source)) {
        continue
    }

    $destination = Join-Path $stagingRoot $item
    if ((Get-Item -LiteralPath $source) -is [System.IO.DirectoryInfo]) {
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    } else {
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

Write-Step "Writing clean portable defaults"
Write-PortableConfig
Write-PortableStateFiles
Write-OneClickLauncher

foreach ($folderName in @("downloads", "processed")) {
    $folderPath = Join-Path $stagingRoot $folderName
    Ensure-Directory $folderPath
}

Write-Step "Writing portable package instructions"
$readmePath = Join-Path $stagingRoot "README-OFFLINE.txt"
@"
LOCAL RUNNER PORTABLE PACKAGE

1. Extract this zip anywhere on a Windows PC.
2. Open the extracted folder.
3. Double-click Start-Portable-Runner.bat or Launch-Local-Runner.bat.
4. This package is intentionally tiny. On first launch it downloads the latest bootstrap and syncs the newest local runner files into %LOCALAPPDATA%\AutomationLocalRunner.
5. setup.bat installs required software, sets up background auto-start, and starts the local dashboard plus runner supervisor.
6. config.txt is intentionally clean. Add the matching RUNNER_TOKEN and ACCESS_TOKEN, then rerun Launch-Local-Runner.bat.
7. runner-state.json and supervisor-state.json ship blank so stale machine state is not reused.
8. If you ever need a manual recycle, run restart-local-runner.ps1 from the installed folder in %LOCALAPPDATA%\AutomationLocalRunner.

This package is designed to be copied to cloud storage and reused on another machine.
"@ | Set-Content -LiteralPath $readmePath -Encoding ASCII

Write-Step "Creating zip archive"
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $zipPath -Force

Write-Step "Portable package ready"
Write-Host "Zip: $zipPath" -ForegroundColor Green
