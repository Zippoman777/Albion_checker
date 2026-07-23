<#
  Albion Profit Forge - self updater
  ---------------------------------------------------------------------------
  Pulls the latest files from a GitHub repository WITHOUT needing git or
  python. It uses only PowerShell (built into every Windows 7+ machine) and
  GitHub's public ZIP download, so it works on a bare PC.

  Exit codes (read by start.bat):
      0  = up to date, or check skipped (offline) -> just launch
      2  = update available but user chose "Later"  -> just launch
     10  = update downloaded and installed          -> launch new version
      1  = an error occurred (non-fatal)            -> launch current version
#>
[CmdletBinding()]
param(
  [string]$Repo   = 'Zippoman777/Albion_checker',
  [string]$Branch = 'main',
  [string]$AppDir = $PSScriptRoot,
  [switch]$NoPrompt   # answer "yes" automatically (for unattended use)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # skip the slow WebRequest progress bar

# GitHub needs TLS 1.2; Windows PowerShell 5.1 does not always default to it.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$VersionFile = Join-Path $AppDir '.app-version'
$Headers = @{ 'User-Agent' = 'AlbionProfitForge-Updater'; 'Accept' = 'application/vnd.github+json' }

function Write-Step($m) { Write-Host "  [update] $m" }

# A GUI popup, with a console fallback if Windows Forms is unavailable.
function Show-Box($text, $title, $buttons = 'OK', $icon = 'Information') {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    return [System.Windows.Forms.MessageBox]::Show($text, $title, $buttons, $icon).ToString()
  } catch {
    Write-Host ""
    Write-Host "  === $title ==="
    Write-Host ("  " + ($text -replace "`n", "`n  "))
    if ($buttons -eq 'YesNo') {
      $r = Read-Host "  Update now? (Y/N)"
      if ($r -match '^(y|yes)$') { return 'Yes' } else { return 'No' }
    }
    return 'OK'
  }
}

# ---------------------------------------------------------------- remote SHA
try {
  $commit = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" `
                              -Headers $Headers -TimeoutSec 12
  $remote = $commit.sha
} catch {
  # Offline, rate-limited, or the repo has no commits yet: never block launch.
  Write-Step "Could not check GitHub (offline, rate-limited, or repo empty). Skipping."
  exit 0
}
if (-not $remote) { Write-Step "No commits found on '$Branch'. Skipping."; exit 0 }
$remoteShort = $remote.Substring(0, 7)

# ----------------------------------------------------------------- local SHA
$local = $null; $localShort = '(unknown)'
if (Test-Path $VersionFile) {
  try {
    $v = Get-Content $VersionFile -Raw | ConvertFrom-Json
    $local = $v.sha
    if ($local) { $localShort = $local.Substring(0, 7) }
  } catch { $local = $null }
}

# First run with this feature: assume the files on disk already match the repo
# (the user just uploaded them), so record a baseline instead of forcing a
# redundant download.
if (-not $local) {
  @{ sha = $remote; branch = $Branch; updated = (Get-Date).ToString('o'); note = 'baseline' } |
    ConvertTo-Json | Set-Content $VersionFile -Encoding UTF8
  Write-Step "Version tracking initialized at $remoteShort. You are up to date."
  exit 0
}

if ($local -eq $remote) {
  Write-Step "You have the latest version ($localShort)."
  exit 0
}

# ------------------------------------------------------------- ask the user
Write-Step "Update available: $localShort -> $remoteShort"
$msg = "A new version of Albion Profit Forge is available." + [Environment]::NewLine + [Environment]::NewLine +
       "  Installed:  $localShort" + [Environment]::NewLine +
       "  Latest:      $remoteShort" + [Environment]::NewLine + [Environment]::NewLine +
       "Update now? Your current files will be backed up first." + [Environment]::NewLine +
       "Choose No to keep using the current version for now."
$answer = if ($NoPrompt) { 'Yes' } else { Show-Box $msg 'Albion Profit Forge - Update available' 'YesNo' 'Question' }
if ($answer -ne 'Yes') {
  Write-Step "Update postponed. Launching current version."
  exit 2
}

# ------------------------------------------------------ download + extract
$stage = Join-Path $env:TEMP ("apf_upd_" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $zip = Join-Path $stage 'repo.zip'
  Write-Step "Downloading update..."
  Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" `
                    -OutFile $zip -Headers $Headers -TimeoutSec 180
  Write-Step "Extracting..."
  Expand-Archive -Path $zip -DestinationPath $stage -Force

  # The ZIP unpacks into <repo>-<branch>\...; locate the folder that actually
  # holds index.html so this works whether files sit at the repo root or in a
  # sub-folder.
  $idx = Get-ChildItem -Path $stage -Recurse -Filter 'index.html' | Select-Object -First 1
  if (-not $idx) { throw "The downloaded archive did not contain index.html." }
  $srcRoot = Split-Path $idx.FullName -Parent
} catch {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Show-Box ("The update could not be downloaded:" + [Environment]::NewLine + [Environment]::NewLine +
            $_.Exception.Message + [Environment]::NewLine + [Environment]::NewLine +
            "Your existing files were not changed.") `
           'Albion Profit Forge - Update failed' 'OK' 'Warning' | Out-Null
  Write-Step "Download failed; keeping current files."
  exit 1
}

# --------------------------------------------------------- backup + install
$backup = Join-Path $AppDir ('.backup\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + "_$localShort")
try {
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Write-Step "Backing up current files..."
  # /XD skips these directories so we never recurse the backup into itself or
  # clone the user's local tooling folders.
  robocopy "$AppDir" "$backup" /E /XD ".backup" ".git" ".claude" /XF ".app-version" `
           /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null

  Write-Step "Installing new files..."
  # No /MIR: we overwrite and add, but never delete the user's own extra files
  # (settings, launch.json, etc.). robocopy exit codes 0-7 all mean success.
  robocopy "$srcRoot" "$AppDir" /E /XD ".backup" ".git" ".claude" `
           /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "File copy failed (robocopy code $LASTEXITCODE)." }

  @{ sha = $remote; branch = $Branch; updated = (Get-Date).ToString('o'); previous = $local } |
    ConvertTo-Json | Set-Content $VersionFile -Encoding UTF8
} catch {
  Show-Box ("The update failed while installing:" + [Environment]::NewLine + [Environment]::NewLine +
            $_.Exception.Message + [Environment]::NewLine + [Environment]::NewLine +
            "A backup of your files is here:" + [Environment]::NewLine + $backup) `
           'Albion Profit Forge - Update failed' 'OK' 'Error' | Out-Null
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Step "Install failed; backup kept at $backup"
  exit 1
}

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Step "Update complete ($remoteShort)."
Show-Box ("Update installed successfully." + [Environment]::NewLine + [Environment]::NewLine +
          "  Version: $remoteShort" + [Environment]::NewLine +
          "  Backup:  $backup" + [Environment]::NewLine + [Environment]::NewLine +
          "The app will now open.") `
         'Albion Profit Forge - Updated' 'OK' 'Information' | Out-Null
exit 10
