param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "AutomationLocalRunner"),
    [string]$SourceDir = "",
    [switch]$RefreshOnly,
    [switch]$NoBrowser,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$DefaultRepoOwner = "waqaskhan1437"
$DefaultRepoName = "waqas-ai-studio"
$DefaultBranch = "master"
$DefaultManifestUrl = "https://raw.githubusercontent.com/waqaskhan1437/waqas-ai-studio/master/local-runner/update-manifest.json"
$DefaultServerUrl = "https://waqas-ai-studio.waqaskhan1437.workers.dev"
$DefaultFrontendUrl = "https://frontend-nine-jet-27.vercel.app"
$ConfigFileName = "config.txt"
$NoCacheHeaders = @{
    "Cache-Control" = "no-cache"
    "Pragma" = "no-cache"
}

function Write-Status {
    param(
        [string]$Message,
        [string]$Color = "Cyan"
    )

    if (-not $Quiet) {
        Write-Host $Message -ForegroundColor $Color
    }
}

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Read-KeyValueConfig {
    param([string]$Path)

    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $values
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) {
            continue
        }

        $parts = $line -split "=", 2
        if ($parts.Count -lt 2) {
            continue
        }

        $values[$parts[0].Trim()] = $parts[1].Trim()
    }

    return $values
}

function Write-KeyValueConfig {
    param(
        [string]$Path,
        [hashtable]$Values
    )

    $lines = @(
        "# Lightweight local launcher",
        "SERVER_URL=$($Values.SERVER_URL)",
        "FRONTEND_URL=$($Values.FRONTEND_URL)",
        "RUNNER_TOKEN=$($Values.RUNNER_TOKEN)",
        "ACCESS_TOKEN=$($Values.ACCESS_TOKEN)",
        "POSTFORME_API_KEY=$($Values.POSTFORME_API_KEY)"
    )

    Set-Content -LiteralPath $Path -Value $lines -Encoding ASCII
}

function Merge-ConfigValues {
    param(
        [hashtable]$BaseValues,
        [hashtable]$SourceValues
    )

    foreach ($key in @("SERVER_URL", "FRONTEND_URL", "RUNNER_TOKEN", "ACCESS_TOKEN", "POSTFORME_API_KEY")) {
        if (
            $SourceValues.ContainsKey($key) -and
            -not [string]::IsNullOrWhiteSpace([string]$SourceValues[$key]) -and
            [string]::IsNullOrWhiteSpace([string]$BaseValues[$key])
        ) {
            $BaseValues[$key] = [string]$SourceValues[$key]
        }
    }

    return $BaseValues
}

function Get-DefaultConfig {
    return @{
        SERVER_URL = $DefaultServerUrl
        FRONTEND_URL = $DefaultFrontendUrl
        RUNNER_TOKEN = ""
        ACCESS_TOKEN = ""
        POSTFORME_API_KEY = ""
    }
}

function Get-ManifestJson {
    param([string]$Url)

    return Invoke-RestMethod -Uri $Url -Headers $NoCacheHeaders -UseBasicParsing
}

function Get-LatestCommitSha {
    param(
        [string]$Owner,
        [string]$Repo,
        [string]$Branch
    )

    $apiUrl = "https://api.github.com/repos/$Owner/$Repo/commits/$Branch"
    $headers = @{
        "User-Agent" = "AutomationLocalRunner"
        "Cache-Control" = "no-cache"
        "Pragma" = "no-cache"
    }

    try {
        $response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -UseBasicParsing
        if ($response.sha) {
            return [string]$response.sha
        }
    } catch {
        Write-Status "[BOOTSTRAP] Commit SHA lookup failed. Falling back to branch URLs." "Yellow"
    }

    return ""
}

function Get-RawBaseUrl {
    param(
        $Manifest,
        [string]$Owner,
        [string]$Repo,
        [string]$Branch,
        [string]$CommitSha
    )

    if ($Manifest.raw_base_url) {
        return ([string]$Manifest.raw_base_url).TrimEnd("/")
    }

    $owner = if ($Manifest.repo_owner) { [string]$Manifest.repo_owner } else { $Owner }
    $repo = if ($Manifest.repo_name) { [string]$Manifest.repo_name } else { $Repo }
    $branch = if ($Manifest.branch) { [string]$Manifest.branch } else { $Branch }
    if (-not [string]::IsNullOrWhiteSpace($CommitSha)) {
        return "https://raw.githubusercontent.com/$owner/$repo/$CommitSha"
    }
    return "https://raw.githubusercontent.com/$owner/$repo/$branch"
}

function Get-ManifestFileEntries {
    param(
        $Manifest,
        [string]$RootPath
    )

    $entries = @()
    foreach ($entry in @($Manifest.files)) {
        if (-not $entry) {
            continue
        }

        $source = if ($null -ne $entry.source) { [string]$entry.source } elseif ($null -ne $entry.path) { [string]$entry.path } else { "" }
        $target = if ($null -ne $entry.target) { [string]$entry.target } elseif ($null -ne $entry.destination) { [string]$entry.destination } else { "" }
        if ([string]::IsNullOrWhiteSpace($source) -or [string]::IsNullOrWhiteSpace($target)) {
            continue
        }

        $normalizedTarget = $target -replace "/", "\"
        $absoluteTarget = [System.IO.Path]::GetFullPath((Join-Path $RootPath $normalizedTarget))
        $absoluteRoot = [System.IO.Path]::GetFullPath($RootPath)
        if (-not $absoluteTarget.StartsWith($absoluteRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to write outside install root: $target"
        }

        $entries += [pscustomobject]@{
            Source = ($source -replace "\\", "/").TrimStart("/")
            RelativeTarget = $normalizedTarget
            AbsoluteTarget = $absoluteTarget
        }
    }

    return $entries
}

function Download-ManifestFile {
    param(
        [string]$RawBaseUrl,
        $Entry
    )

    $url = "$RawBaseUrl/$($Entry.Source)"
    $tempFile = "$($Entry.AbsoluteTarget).download"
    Ensure-Directory (Split-Path -Parent $Entry.AbsoluteTarget)
    Invoke-WebRequest -Uri $url -Headers $NoCacheHeaders -OutFile $tempFile -UseBasicParsing
    Copy-Item -LiteralPath $tempFile -Destination $Entry.AbsoluteTarget -Force
    Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
}

function Ensure-StateFiles {
    param([string]$RootPath)

    $runnerStatePath = Join-Path $RootPath "runner-state.json"
    if (-not (Test-Path -LiteralPath $runnerStatePath)) {
        @"
{
  "status": "not_started",
  "message": "Runner has not reported status yet.",
  "updatedAt": null,
  "currentJobId": null,
  "processedVideos": 0,
  "lastError": ""
}
"@ | Set-Content -LiteralPath $runnerStatePath -Encoding ASCII
    }

    $supervisorStatePath = Join-Path $RootPath "supervisor-state.json"
    if (-not (Test-Path -LiteralPath $supervisorStatePath)) {
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
"@ | Set-Content -LiteralPath $supervisorStatePath -Encoding ASCII
    }

    foreach ($folderName in @("downloads", "processed", "runner-scripts\output", "tools")) {
        Ensure-Directory (Join-Path $RootPath $folderName)
    }
}

function Sync-InstallRoot {
    param(
        [string]$RootPath,
        [string]$SourceDirectory
    )

    Write-Status "[BOOTSTRAP] Syncing latest local runner into $RootPath"
    Ensure-Directory $RootPath

    $commitSha = Get-LatestCommitSha -Owner $DefaultRepoOwner -Repo $DefaultRepoName -Branch $DefaultBranch
    $manifestUrl = if ([string]::IsNullOrWhiteSpace($commitSha)) {
        $DefaultManifestUrl
    } else {
        "https://raw.githubusercontent.com/$DefaultRepoOwner/$DefaultRepoName/$commitSha/local-runner/update-manifest.json"
    }

    $manifest = Get-ManifestJson -Url $manifestUrl
    $rawBaseUrl = Get-RawBaseUrl -Manifest $manifest -Owner $DefaultRepoOwner -Repo $DefaultRepoName -Branch $DefaultBranch -CommitSha $commitSha
    $entries = Get-ManifestFileEntries -Manifest $manifest -RootPath $RootPath

    foreach ($entry in $entries) {
        Download-ManifestFile -RawBaseUrl $rawBaseUrl -Entry $entry
    }

    $installConfigPath = Join-Path $RootPath $ConfigFileName
    $configValues = Get-DefaultConfig
    $configValues = Merge-ConfigValues -BaseValues $configValues -SourceValues (Read-KeyValueConfig -Path $installConfigPath)

    if (-not [string]::IsNullOrWhiteSpace($SourceDirectory)) {
        $sourceConfigPath = Join-Path $SourceDirectory $ConfigFileName
        if ((Test-Path -LiteralPath $sourceConfigPath) -and ($sourceConfigPath -ne $installConfigPath)) {
            $configValues = Merge-ConfigValues -BaseValues $configValues -SourceValues (Read-KeyValueConfig -Path $sourceConfigPath)
        }
    }

    Write-KeyValueConfig -Path $installConfigPath -Values $configValues
    Ensure-StateFiles -RootPath $RootPath

    return @{
        Manifest = $manifest
        RawBaseUrl = $rawBaseUrl
        FileCount = $entries.Count
        ConfigPath = $installConfigPath
    }
}

$resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$resolvedSourceDir = if ([string]::IsNullOrWhiteSpace($SourceDir)) { "" } else { [System.IO.Path]::GetFullPath($SourceDir) }

$syncResult = Sync-InstallRoot -RootPath $resolvedInstallRoot -SourceDirectory $resolvedSourceDir
Write-Status "[BOOTSTRAP] Synced $($syncResult.FileCount) files from $($syncResult.RawBaseUrl)" "Green"

if ($RefreshOnly) {
    Write-Status "[BOOTSTRAP] Refresh-only mode complete." "Green"
    exit 0
}

$setupPath = Join-Path $resolvedInstallRoot "setup.bat"
if (-not (Test-Path -LiteralPath $setupPath)) {
    throw "setup.bat not found after sync: $setupPath"
}

Write-Status "[BOOTSTRAP] Launching one-click setup..." "Green"
if ($NoBrowser) {
    $env:AUTOMATION_NO_BROWSER = "1"
}

Push-Location $resolvedInstallRoot
try {
    & cmd.exe /c "call `"$setupPath`""
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
