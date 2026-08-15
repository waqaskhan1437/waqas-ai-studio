@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   Automation Launcher - Quick Setup
echo ========================================
echo.

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "TOOLS_DIR=%SCRIPT_DIR%tools"
set "NODE_DIR=%TOOLS_DIR%\node"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "FFMPEG_DIR=%TOOLS_DIR%\ffmpeg"
set "FFMPEG_EXE=%FFMPEG_DIR%\bin\ffmpeg.exe"
set "YTDLP_DIR=%TOOLS_DIR%\yt-dlp"
set "YTDLP_EXE=%YTDLP_DIR%\yt-dlp.exe"
if not exist "%TOOLS_DIR%" mkdir "%TOOLS_DIR%" >nul 2>nul

set "PATH=%NODE_DIR%;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\AppData\Roaming\npm;%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links;%LOCALAPPDATA%\Microsoft\WindowsApps;%FFMPEG_DIR%\bin;%YTDLP_DIR%;%PATH%"
set "NODE_CMD=node"
set "SHOULD_OPEN_BROWSER=1"

if /I "%AUTOMATION_NO_BROWSER%"=="1" (
    set "SHOULD_OPEN_BROWSER=0"
)

if exist "%NODE_EXE%" (
    set "NODE_CMD=%NODE_EXE%"
)

echo [1/9] Checking Node.js...
call :check_node
if %errorlevel% neq 0 (
    where winget >nul 2>nul
    if %errorlevel% equ 0 (
        echo Installing Node.js with winget...
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    ) else (
        echo Installing portable Node.js locally...
        if not exist "%NODE_DIR%" mkdir "%NODE_DIR%" >nul 2>nul
        powershell -NoProfile -ExecutionPolicy Bypass -Command "$zipPath = Join-Path $env:TEMP 'node-v20.11.0-win-x64.zip'; $extractPath = Join-Path $env:TEMP 'node-portable'; Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.0/node-v20.11.0-win-x64.zip' -OutFile $zipPath; Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force; $nodeRoot = Get-ChildItem $extractPath | Where-Object { $_.PSIsContainer } | Select-Object -First 1; if ($nodeRoot) { Copy-Item -Path (Join-Path $nodeRoot.FullName '*') -Destination '%NODE_DIR%' -Recurse -Force }"
        del "%TEMP%\node-v20.11.0-win-x64.zip" >nul 2>nul
    )
    set "PATH=%NODE_DIR%;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%PATH%"
    if exist "%NODE_EXE%" (
        set "NODE_CMD=%NODE_EXE%"
    )
)
call :check_node
if %errorlevel% neq 0 (
    echo [ERROR] Node.js install failed. Please install Node.js manually and run setup again.
    exit /b 1
)
echo [OK] Node.js ready

echo [2/9] Checking FFmpeg...
call :check_ffmpeg
if %errorlevel% neq 0 (
    where winget >nul 2>nul
    if %errorlevel% equ 0 (
        echo Installing FFmpeg with winget...
        winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements --silent
    ) else (
        echo Installing portable FFmpeg locally...
        if not exist "%FFMPEG_DIR%" mkdir "%FFMPEG_DIR%" >nul 2>nul
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile '%TEMP%\\ffmpeg-release-essentials.zip'; Expand-Archive -LiteralPath '%TEMP%\\ffmpeg-release-essentials.zip' -DestinationPath '%TEMP%\\ffmpeg-portable' -Force; $ffmpegRoot = Get-ChildItem '%TEMP%\\ffmpeg-portable' | Where-Object { $_.PSIsContainer } | Select-Object -First 1; if ($ffmpegRoot) { Copy-Item -Path ($ffmpegRoot.FullName + '\\*') -Destination '%FFMPEG_DIR%' -Recurse -Force }"
        del "%TEMP%\ffmpeg-release-essentials.zip" >nul 2>nul
    )
)
call :check_ffmpeg
if %errorlevel% neq 0 (
    echo [WARN] FFmpeg still not available in PATH. Local video processing may fail until it is installed.
) else (
    echo [OK] FFmpeg ready
)

echo [3/9] Checking yt-dlp...
call :check_ytdlp
if %errorlevel% neq 0 (
    where winget >nul 2>nul
    if %errorlevel% equ 0 (
        echo Installing yt-dlp with winget...
        winget install -e --id yt-dlp.yt-dlp --accept-source-agreements --accept-package-agreements --silent
    ) else (
        where python >nul 2>nul
        if %errorlevel% equ 0 (
            echo Installing yt-dlp with pip...
            python -m pip install --user -U yt-dlp >nul 2>nul
        ) else (
            echo Installing portable yt-dlp locally...
            if not exist "%YTDLP_DIR%" mkdir "%YTDLP_DIR%" >nul 2>nul
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile '%YTDLP_DIR%\\yt-dlp.exe'"
        )
    )
)
set "PATH=%PATH%;%USERPROFILE%\AppData\Roaming\Python\Python313\Scripts;%USERPROFILE%\AppData\Roaming\Python\Python312\Scripts;%USERPROFILE%\AppData\Roaming\Python\Python311\Scripts"
call :check_ytdlp
if %errorlevel% neq 0 (
    echo [WARN] yt-dlp still not available in PATH. Download-based sources may fail until it is installed.
) else (
    echo [OK] yt-dlp ready
)

echo [4/9] Installing Node modules...
set "HAS_DEPENDENCIES="
if exist "package.json" (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$pkg = Get-Content 'package.json' | ConvertFrom-Json; if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties.Count -gt 0) { 'yes' }"`) do set "HAS_DEPENDENCIES=%%i"
)
if /I "!HAS_DEPENDENCIES!"=="yes" (
    if not exist "node_modules" (
        call :npm_install_with_retry "%SCRIPT_DIR%"
        if !errorlevel! neq 0 (
            echo [ERROR] npm install failed for local-runner.
            exit /b 1
        )
    )
    echo [OK] local-runner dependencies ready
) else (
    echo [OK] No local-runner npm dependencies to install
)

REM Install runner-scripts deps too (these are what the runtime actually needs:
REM axios, playwright-core, youtubei.js). Skip if already bundled or absent.
set "RUNNER_SCRIPTS_DIR=%SCRIPT_DIR%..\runner-scripts"
if not exist "%RUNNER_SCRIPTS_DIR%\package.json" set "RUNNER_SCRIPTS_DIR=%SCRIPT_DIR%runner-scripts"
if exist "%RUNNER_SCRIPTS_DIR%\package.json" (
    if not exist "%RUNNER_SCRIPTS_DIR%\node_modules" (
        echo Installing runner-scripts dependencies...
        call :npm_install_with_retry "%RUNNER_SCRIPTS_DIR%"
        if !errorlevel! neq 0 (
            echo [WARN] runner-scripts npm install failed after retries. Runtime will retry on first job.
        ) else (
            echo [OK] runner-scripts dependencies ready
        )
    ) else (
        echo [OK] runner-scripts dependencies already present
    )
) else (
    echo [INFO] runner-scripts package.json not found; skipping
)

echo [5/9] Checking portable pipeline files...
if not exist "runner-scripts\\main.js" if not exist "..\\runner-scripts\\main.js" (
    echo [ERROR] runner-scripts package is missing. Rebuild the portable zip and extract it again.
    exit /b 1
)
if not exist "tools\\ffmpeg\\bin\\ffprobe.exe" (
    where ffprobe >nul 2>nul
    if %errorlevel% neq 0 (
        echo [WARN] ffprobe.exe is not bundled yet and not available in PATH. Extra video validation may be skipped until FFmpeg portable files are cached.
    )
)
echo [OK] Portable runner-scripts ready

echo [6/9] Checking Configuration...
if not exist "config.txt" (
    (
        echo # Lightweight local launcher
        echo SERVER_URL=https://waqas-ai-studio.waqaskhan1437.workers.dev
        echo FRONTEND_URL=https://frontend-nine-jet-27.vercel.app
        echo RUNNER_TOKEN=
        echo ACCESS_TOKEN=
    ) > config.txt
)
echo [OK] Configuration file ready

echo [7/9] Checking Tailscale + SSH...
if /I "%AUTOMATION_SKIP_TAILSCALE%"=="1" (
    echo [SKIP] Remote access bootstrap skipped by AUTOMATION_SKIP_TAILSCALE
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "install-tailscale.ps1"
    if %errorlevel% neq 0 (
        echo [WARN] Tailscale/OpenSSH bootstrap failed. Remote access will stay disabled until setup succeeds.
    ) else (
        echo [OK] Remote access bootstrap checked
    )
)

echo [8/9] Installing auto-start task...
if /I "%AUTOMATION_SKIP_AUTOSTART%"=="1" (
    echo [SKIP] Startup task install skipped by AUTOMATION_SKIP_AUTOSTART
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "install-startup-task.ps1"
    if %errorlevel% neq 0 (
        echo [WARN] Startup task install failed. You can still use restart-local-runner.ps1 manually.
    ) else (
        echo [OK] Startup task installed
    )
)

echo [9/9] Starting background services...
if /I "%AUTOMATION_SKIP_RESTART%"=="1" (
    echo [SKIP] Background restart skipped by AUTOMATION_SKIP_RESTART
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "restart-local-runner.ps1"
)

set "DASHBOARD_READY=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline = (Get-Date).AddSeconds(20); while ((Get-Date) -lt $deadline) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/self-check' -TimeoutSec 2; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { exit 0 } } catch {} Start-Sleep -Milliseconds 750 }; exit 1"
if %errorlevel% equ 0 (
    set "DASHBOARD_READY=1"
)

if /I "%SHOULD_OPEN_BROWSER%"=="1" if /I "%DASHBOARD_READY%"=="1" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process 'http://localhost:3000/launcher'"
)

echo.
echo ========================================
echo   Ready
echo   Background runner started
if /I "%SHOULD_OPEN_BROWSER%"=="0" (
    echo   Browser auto-open skipped
) else if /I "%DASHBOARD_READY%"=="1" (
    echo   Browser opening on localhost:3000/launcher
) else (
    echo   Dashboard is still warming up
    echo   Open this link manually if browser does not open: http://localhost:3000/launcher
)
echo ========================================
echo.
exit /b 0

:npm_install_with_retry
REM %~1 = directory containing package.json
setlocal
set "TARGET_DIR=%~1"
set "ATTEMPTS=0"
set "MAX_ATTEMPTS=3"
:npm_retry
set /a ATTEMPTS+=1
echo   npm install attempt !ATTEMPTS!/!MAX_ATTEMPTS! in "!TARGET_DIR!"
pushd "!TARGET_DIR!" >nul
call npm install --no-fund --no-audit --omit=dev --prefer-offline
set "NPM_EXIT=!errorlevel!"
popd >nul
if "!NPM_EXIT!"=="0" (
    endlocal & exit /b 0
)
if !ATTEMPTS! lss !MAX_ATTEMPTS! (
    echo   npm install returned !NPM_EXIT!. Retrying in 3 seconds...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 3" >nul
    goto :npm_retry
)
echo   npm install gave up after !MAX_ATTEMPTS! attempts (last exit code !NPM_EXIT!).
endlocal & exit /b 1

:check_node
if exist "%NODE_EXE%" exit /b 0
where node >nul 2>nul
exit /b %errorlevel%

:check_ffmpeg
if exist "%FFMPEG_EXE%" exit /b 0
where ffmpeg >nul 2>nul
exit /b %errorlevel%

:check_ytdlp
if exist "%YTDLP_EXE%" exit /b 0
where yt-dlp >nul 2>nul
exit /b %errorlevel%
