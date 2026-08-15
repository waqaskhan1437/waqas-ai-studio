@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"
set "LOCAL_LAUNCHER=%SCRIPT_DIR%Launch-Local-Runner.bat"
set "LOCAL_BOOTSTRAP=%SCRIPT_DIR%bootstrap.ps1"
set "INSTALL_ROOT=%LOCALAPPDATA%\AutomationLocalRunner"

if exist "%SCRIPT_DIR%supervisor.js" (
    goto :run_local_supervisor
)

if exist "%LOCAL_LAUNCHER%" (
    call "%LOCAL_LAUNCHER%"
    exit /b %errorlevel%
)

echo ========================================
echo   Local Background Supervisor
echo   Downloading latest launcher...
echo ========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $tmp = Join-Path $env:TEMP 'automation-local-runner-bootstrap.ps1'; $headers = @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache'; 'User-Agent' = 'AutomationLocalRunner' }; $bootstrapUri = 'https://raw.githubusercontent.com/waqaskhan1437/waqas-ai-studio/master/local-runner/bootstrap.ps1'; try { $commit = Invoke-RestMethod -Uri 'https://api.github.com/repos/waqaskhan1437/waqas-ai-studio/commits/master' -Headers $headers -UseBasicParsing; if ($commit.sha) { $bootstrapUri = 'https://raw.githubusercontent.com/waqaskhan1437/waqas-ai-studio/' + $commit.sha + '/local-runner/bootstrap.ps1' } Invoke-WebRequest -Uri $bootstrapUri -Headers $headers -OutFile $tmp -UseBasicParsing; $bootstrapPath = $tmp } catch { if (Test-Path -LiteralPath '%LOCAL_BOOTSTRAP%') { $bootstrapPath = '%LOCAL_BOOTSTRAP%' } else { throw } }; & $bootstrapPath -InstallRoot '%INSTALL_ROOT%' -SourceDir '%SCRIPT_DIR%'"

if errorlevel 1 (
  echo.
  echo [ERROR] Local runner bootstrap failed.
  pause
  exit /b 1
)

exit /b 0

:run_local_supervisor
set "TOOLS_DIR=%SCRIPT_DIR%tools"
set "NODE_DIR=%TOOLS_DIR%\node"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "FFMPEG_DIR=%TOOLS_DIR%\ffmpeg"
set "YTDLP_DIR=%TOOLS_DIR%\yt-dlp"
set "PATH=%NODE_DIR%;%FFMPEG_DIR%\bin;%YTDLP_DIR%;%PATH%"
set "NODE_CMD=node"

if exist "%NODE_EXE%" (
    set "NODE_CMD=%NODE_EXE%"
)

:loop
echo ========================================
echo   Local Background Supervisor
echo   Starting supervisor.js
echo ========================================
call "%NODE_CMD%" supervisor.js
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="10" (
    echo [INFO] Background supervisor is already running. Exiting wrapper.
    exit /b 0
)
echo.
echo [WARN] supervisor.js exited. Restarting in 5 seconds...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 5" >nul
goto loop
