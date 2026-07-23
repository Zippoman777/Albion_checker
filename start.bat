@echo off
setlocal EnableDelayedExpansion
title Albion Profit Forge - Launcher

REM ==========================================================
REM  SELF-RELAUNCH GUARD
REM  The updater may overwrite start.bat while we are running. cmd.exe reads a
REM  running .bat from disk line by line, so replacing it mid-run corrupts
REM  execution. To stay safe we copy ourselves to %TEMP% and hand control to
REM  that copy (which is never touched by the update). Invoking a .bat without
REM  "call" transfers control and never returns, so once we are the temp copy,
REM  the original in the app folder can be replaced freely.
REM ==========================================================
if /i "%~1"=="--worker" (
  set "APPDIR=%~2"
  goto :worker
)

REM strip trailing backslash so "C:\path\" does not escape the closing quote
set "APPDIR=%~dp0"
if "!APPDIR:~-1!"=="\" set "APPDIR=!APPDIR:~0,-1!"

del "%TEMP%\apf_launcher_*.bat" >nul 2>&1
set "WORKER=%TEMP%\apf_launcher_%RANDOM%%RANDOM%.bat"
copy /y "%~f0" "!WORKER!" >nul 2>&1
if exist "!WORKER!" (
  "!WORKER!" --worker "!APPDIR!"
  exit /b
)
REM could not stage a temp copy: run in place with self-update disabled
set "NOUPDATE=1"
goto :worker

:worker
cd /d "%APPDIR%"

set "APPNAME=Albion Profit Forge"
set "SERVERTITLE=AlbionProfitForgeServer"
set "PORT=8123"
set "REPO=Zippoman777/Albion_checker"
set "BRANCH=main"

echo.
echo  ===========================================================
echo    %APPNAME%  -  launcher
echo  ===========================================================
echo.

REM ==========================================================
REM  STEP 0a  -  first-run bootstrap: if the app is not here, download the
REM  whole project from GitHub. This lets start.bat be shared on its own as a
REM  one-file installer. Needs only PowerShell (built into Windows) + internet.
REM ==========================================================
if exist "index.html" goto :afterboot

echo  [setup] Application files not found - this looks like a fresh install.
echo  [setup] Downloading %APPNAME% from GitHub...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" ^
  "try{[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12}catch{};" ^
  "$h=@{'User-Agent'='AlbionProfitForge-Bootstrap'};" ^
  "$tmp=Join-Path $env:TEMP ('apf_boot_'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $tmp|Out-Null;" ^
  "$zip=Join-Path $tmp 'repo.zip';" ^
  "Invoke-WebRequest ('https://codeload.github.com/%REPO%/zip/refs/heads/%BRANCH%') -OutFile $zip -Headers $h -TimeoutSec 180;" ^
  "Expand-Archive $zip $tmp -Force;" ^
  "$idx=Get-ChildItem $tmp -Recurse -Filter index.html|Select-Object -First 1;" ^
  "if(-not $idx){throw 'archive missing index.html'};" ^
  "robocopy $idx.Directory.FullName '%APPDIR%' /E /XD '.git' /R:1 /W:1 /NFL /NDL /NJH /NJS /NP|Out-Null;" ^
  "Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue;" ^
  "Write-Host '  [setup] Download complete.'"

if not exist "index.html" (
  echo.
  echo  -----------------------------------------------------------
  echo   PROBLEM: could not download the application.
  echo  -----------------------------------------------------------
  echo.
  echo   The one-file installer needs an internet connection the first
  echo   time, to fetch the app from:
  echo       https://github.com/%REPO%
  echo.
  echo   Check your connection ^(and any antivirus/firewall block on
  echo   PowerShell^) and run start.bat again.
  echo.
  goto :fail
)
echo.

:afterboot

REM ==========================================================
REM  STEP 0  -  check GitHub for an update (needs neither Python nor Git)
REM ==========================================================
if defined NOUPDATE goto :afterupdate
if not exist "update.ps1" goto :afterupdate

echo  [0/3] Checking for updates...
powershell -NoProfile -ExecutionPolicy Bypass -File "update.ps1" -AppDir "%APPDIR%"
if "!errorlevel!"=="10" (
  echo        Updated to the latest version.
) else (
  echo        Update check done.
)
echo.

:afterupdate

REM ==========================================================
REM  STEP 1  -  check that all application files are present
REM ==========================================================
echo  [1/3] Checking application files...

set "MISSING="
set "NMISSING=0"
for %%F in (
  index.html
  manifest.json
  sw.js
  css\styles.css
  js\config.js
  js\store.js
  js\recipes.js
  js\api.js
  js\calc.js
  js\ui.js
  js\app.js
) do (
  if not exist "%%F" (
    set "MISSING=!MISSING! %%F"
    set /a NMISSING+=1
  )
)

if not "!MISSING!"=="" (
  echo.
  echo  -----------------------------------------------------------
  echo   PROBLEM: !NMISSING! required file^(s^) are missing
  echo  -----------------------------------------------------------
  echo.
  for %%M in (!MISSING!) do echo     [X] missing:  %%M
  echo.
  echo   Expected folder: %~dp0
  echo.
  echo   How to fix:
  echo     - Make sure start.bat is in the SAME folder as index.html.
  echo     - If you copied the app, copy the whole folder including
  echo       the "js" and "css" sub-folders, not just index.html.
  echo.
  goto :fail
)
echo        OK - all 11 application files found.
echo.

REM ==========================================================
REM  STEP 2  -  find a runtime that can serve static files
REM ==========================================================
echo  [2/3] Looking for a way to run a local web server...

set "RUNTIME="
set "RUNTIMENAME="

REM -- Python via the "py" launcher (most reliable on Windows)
py -3 -c "pass" >nul 2>&1
if not errorlevel 1 (
  set "RUNTIME=py -3 -m http.server"
  set "RUNTIMENAME=Python (py launcher)"
)

REM -- Plain "python" on PATH. The Windows Store stub also answers to
REM    "python" but fails to execute code, so we test real execution.
if not defined RUNTIME (
  python -c "pass" >nul 2>&1
  if not errorlevel 1 (
    set "RUNTIME=python -m http.server"
    set "RUNTIMENAME=Python"
  )
)

REM -- Node.js fallback (downloads http-server on first use)
if not defined RUNTIME (
  node -e "process.exit(0)" >nul 2>&1
  if not errorlevel 1 (
    set "RUNTIME=npx --yes http-server -c-1 --silent -p"
    set "RUNTIMENAME=Node.js (via npx http-server)"
    set "NODEMODE=1"
  )
)

if not defined RUNTIME (
  echo.
  echo  -----------------------------------------------------------
  echo   PROBLEM: no supported runtime found on this PC
  echo  -----------------------------------------------------------
  echo.
  echo     [X] Python  - not found ^(checked "py" and "python"^)
  echo     [X] Node.js - not found ^(checked "node"^)
  echo.
  echo   This app is plain HTML/CSS/JavaScript, but it MUST be served
  echo   over http:// . Opening index.html by double-clicking gives a
  echo   file:// page, and the browser then blocks the price API calls.
  echo   So a tiny local web server is required - that is all either
  echo   of these is used for.
  echo.
  echo   Install ONE of the following, then run start.bat again:
  echo.
  echo     Python  ^(recommended, smaller download^)
  echo       https://www.python.org/downloads/
  echo       IMPORTANT: tick "Add python.exe to PATH" in the installer.
  echo.
  echo     Node.js
  echo       https://nodejs.org/en/download
  echo.
  choice /C YN /N /M "  Open the Python download page in your browser now? [Y/N] "
  if !errorlevel!==1 start "" "https://www.python.org/downloads/"
  goto :fail
)
echo        OK - using !RUNTIMENAME!.
echo.

REM ==========================================================
REM  STEP 3  -  pick a free port, start the server, open browser
REM ==========================================================
echo  [3/3] Starting the local server...

REM -- Find a free port. We probe with a real HTTP request rather than netstat:
REM    Python's http.server sets SO_REUSEADDR, so on Windows a second process
REM    can bind a port that is already in use. netstat would say "free enough"
REM    and the user would silently end up talking to somebody else's server.
set /a TRIES=0
:findport
call :probe !PORT!
if !errorlevel!==0 (
  set /a PORT+=1
  set /a TRIES+=1
  if !TRIES! lss 25 goto :findport
  echo.
  echo   PROBLEM: ports 8123-!PORT! are all in use.
  echo   Close some running servers and try again.
  goto :fail
)

start "%SERVERTITLE%" /min cmd /c "!RUNTIME! !PORT!"

REM -- Wait until the server actually answers with OUR page (up to ~15s).
set /a WAIT=0
:waitport
ping -n 2 127.0.0.1 >nul
call :probe !PORT!
if not !errorlevel!==0 (
  set /a WAIT+=1
  if !WAIT! lss 8 goto :waitport
  echo.
  echo  -----------------------------------------------------------
  echo   PROBLEM: the server did not come up on port !PORT!.
  echo  -----------------------------------------------------------
  echo.
  echo   A window titled "%SERVERTITLE%" was opened but it is not
  echo   answering. Common causes:
  echo     - antivirus or firewall blocked the local server
  echo     - !RUNTIMENAME! is installed but not working correctly
  if defined NODEMODE echo     - npx could not download http-server ^(needs internet once^)
  echo.
  echo   To see the real error, open a terminal in this folder and run:
  echo       !RUNTIME! !PORT!
  echo.
  goto :fail
)

set "URL=http://localhost:!PORT!/index.html"
start "" "!URL!"

echo        OK - server is running.
echo.
echo  ===========================================================
echo    %APPNAME% is now running
echo.
echo      !URL!
echo.
echo    Your browser should have opened automatically.
echo    If not, copy the address above into your browser.
echo.
echo    NOTE: the first load takes 10-20 seconds while live price
echo    data is downloaded from albion-online-data.com. It needs
echo    an internet connection. After that it is cached.
echo  ===========================================================
echo.
echo    Press any key to STOP the server and close everything.
echo.
pause >nul

echo  Stopping server...
taskkill /FI "WINDOWTITLE eq %SERVERTITLE%*" /T /F >nul 2>&1
echo  Done.
REM ping, not timeout: timeout aborts with an error if stdin is redirected.
ping -n 2 127.0.0.1 >nul
exit /b 0

REM ==========================================================
REM  :probe <port>
REM  Returns errorlevel 0 if something is already answering HTTP on that
REM  port, 1 if the port is free / silent. Used both to find a free port
REM  and to confirm our own server came up.
REM ==========================================================
:probe
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:%~1/' -UseBasicParsing -TimeoutSec 3; exit 0 } catch { if ($_.Exception.Response) { exit 0 } else { exit 1 } }" >nul 2>&1
exit /b %errorlevel%

REM ==========================================================
:fail
echo  -----------------------------------------------------------
echo   The app was NOT started.
echo  -----------------------------------------------------------
echo.
pause
exit /b 1
