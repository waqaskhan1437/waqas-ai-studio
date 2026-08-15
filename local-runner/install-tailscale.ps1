param()

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$configPath = Join-Path $scriptDir "config.txt"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Load-Config {
    $config = @{
        SERVER_URL = "https://waqas-ai-studio.waqaskhan1437.workers.dev"
        RUNNER_TOKEN = ""
        ACCESS_TOKEN = ""
    }

    if (-not (Test-Path -LiteralPath $configPath)) {
        return $config
    }

    foreach ($line in Get-Content -LiteralPath $configPath) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) {
            continue
        }

        $parts = $line -split "=", 2
        if ($parts.Count -ne 2) {
            continue
        }

        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        if ($key) {
            $config[$key] = $value
        }
    }

    return $config
}

function Get-TailscaleExe {
    $programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { "C:\Program Files" }
    $programFilesX86 = if (${env:ProgramFiles(x86)}) { ${env:ProgramFiles(x86)} } else { "C:\Program Files (x86)" }
    $candidates = @(
        (Join-Path $programFiles "Tailscale\tailscale.exe"),
        (Join-Path $programFilesX86 "Tailscale\tailscale.exe")
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    return $null
}

function Ensure-TailscaleInstalled {
    $tailscaleExe = Get-TailscaleExe
    if ($tailscaleExe) {
        Write-Host "Tailscale already installed"
        return $tailscaleExe
    }

    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "Installing Tailscale with winget..."
        try {
            & $winget.Source install -e --id Tailscale.Tailscale --accept-source-agreements --accept-package-agreements --silent | Out-Null
        } catch {
            Write-Warning "winget Tailscale install failed: $($_.Exception.Message)"
        }

        $tailscaleExe = Get-TailscaleExe
        if ($tailscaleExe) {
            return $tailscaleExe
        }
    }

    Write-Host "Installing Tailscale from the official stable packages feed..."
    $listing = Invoke-WebRequest -Uri "https://pkgs.tailscale.com/stable/" -UseBasicParsing
    $archSuffix = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "x86" }
    $pattern = "tailscale-setup-[0-9\.\-]+-$archSuffix\.msi"
    $match = [regex]::Match($listing.Content, $pattern)
    if (-not $match.Success) {
        $match = [regex]::Match($listing.Content, "tailscale-setup-[0-9\.\-]+-(amd64|x86)\.msi")
    }

    if (-not $match.Success) {
        throw "Could not locate a Windows Tailscale installer from the stable feed."
    }

    $installerName = $match.Value
    $installerPath = Join-Path $env:TEMP $installerName
    Invoke-WebRequest -Uri ("https://pkgs.tailscale.com/stable/" + $installerName) -OutFile $installerPath -UseBasicParsing
    Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $installerPath, "/qn", "/norestart") -Wait -NoNewWindow

    $tailscaleExe = Get-TailscaleExe
    if (-not $tailscaleExe) {
        throw "Tailscale install finished but tailscale.exe was not found."
    }

    return $tailscaleExe
}

function Ensure-OpenSshEnabled {
    Write-Host "Ensuring Windows OpenSSH Server is installed..."

    try {
        $capability = Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0"
        if ($capability.State -ne "Installed") {
            Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
        }
    } catch {
        Write-Warning "OpenSSH capability install skipped: $($_.Exception.Message)"
    }

    $service = Get-Service sshd -ErrorAction SilentlyContinue
    if ($service) {
        Set-Service -Name sshd -StartupType Automatic
        if ($service.Status -ne "Running") {
            Start-Service sshd
        }
    }

    $firewallRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
    if ($firewallRule) {
        Enable-NetFirewallRule -Name "OpenSSH-Server-In-TCP" | Out-Null
    } else {
        New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    }
}

function New-DesiredHostname([string]$Prefix) {
    $baseName = [Environment]::MachineName
    if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
        $baseName = "$Prefix-$baseName"
    }

    $sanitized = ($baseName.ToLowerInvariant() -replace "[^a-z0-9-]", "-").Trim("-")
    if (-not $sanitized) {
        return $null
    }

    if ($sanitized.Length -gt 63) {
        return $sanitized.Substring(0, 63).Trim("-")
    }

    return $sanitized
}

function Get-BootstrapSettings($Config) {
    $token = $Config.RUNNER_TOKEN
    if ([string]::IsNullOrWhiteSpace($token)) {
        Write-Host "RUNNER_TOKEN is missing, skipping remote access bootstrap."
        return $null
    }

    $payload = @{
        token = $token
    } | ConvertTo-Json -Compress

    try {
        $response = Invoke-RestMethod -Method Post -Uri (($Config.SERVER_URL.TrimEnd("/")) + "/api/runner/bootstrap") -ContentType "application/json" -Body $payload
        return $response.data.tailscale
    } catch {
        Write-Warning "Could not fetch Tailscale bootstrap settings: $($_.Exception.Message)"
        return $null
    }
}

$config = Load-Config
$tailscale = Get-BootstrapSettings $config

if (-not $tailscale) {
    exit 0
}

if (-not $tailscale.auto_install) {
    Write-Host "Tailscale auto-install is disabled for this runner."
    exit 0
}

if ([string]::IsNullOrWhiteSpace($tailscale.auth_key)) {
    Write-Warning "Tailscale auto-install is enabled but no auth key is configured."
    exit 0
}

Write-Step "Preparing Tailscale remote access"
$tailscaleExe = Ensure-TailscaleInstalled
$desiredHostname = New-DesiredHostname $tailscale.hostname_prefix

$arguments = @("up")
if ($tailscale.unattended) {
    $arguments += "--unattended=true"
}
if (-not [string]::IsNullOrWhiteSpace($desiredHostname)) {
    $arguments += "--hostname=$desiredHostname"
}
if (-not [string]::IsNullOrWhiteSpace($tailscale.device_tag)) {
    $arguments += "--advertise-tags=$($tailscale.device_tag.Trim())"
}

$env:TS_AUTH_KEY = [string]$tailscale.auth_key
$arguments += "--auth-key=$env:TS_AUTH_KEY"
try {
    & $tailscaleExe @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "tailscale up exited with code $LASTEXITCODE"
    }
} finally {
    Remove-Item Env:\TS_AUTH_KEY -ErrorAction SilentlyContinue
}

if ($tailscale.ssh_enabled) {
    Ensure-OpenSshEnabled
}

Write-Step "Remote access bootstrap complete"
