# install.ps1 — install the magent CLI binary on Windows (no Node.js / npm required)
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/royhyang/cloudbase-managed-agent/main/install.ps1 | iex
#
# Environment overrides (set before running):
#   $env:MAGENT_INSTALL_DIR  — where to place magent.exe  (default: %LOCALAPPDATA%\magent\bin)
#   $env:MAGENT_VERSION      — release tag, e.g. "v0.2.0"  (default: latest)

$ErrorActionPreference = "Stop"

$Repo       = "royhyang/cloudbase-managed-agent"
$Binary     = "magent.exe"
$AssetName  = "magent-windows-x64.exe"
$InstallDir = if ($env:MAGENT_INSTALL_DIR) { $env:MAGENT_INSTALL_DIR } else { "$env:LOCALAPPDATA\magent\bin" }
$Version    = $env:MAGENT_VERSION   # empty → resolve latest

function Write-Info { param($msg) Write-Host "▶ $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "⚠  $msg" -ForegroundColor Yellow }
function Fail       { param($msg) Write-Host "✗  $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Installing magent" -ForegroundColor White
Write-Host "────────────────────────────────────────"
Write-Host ""

# ── Resolve latest version ────────────────────────────────────────────────────
if (-not $Version) {
    Write-Info "Resolving latest release..."
    try {
        $Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
        $Version = $Release.tag_name
    } catch {
        Fail "Could not fetch latest release info: $_`nSet `$env:MAGENT_VERSION and retry."
    }
}
Write-Info "Version: $Version"

$DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$AssetName"

# ── Download ──────────────────────────────────────────────────────────────────
Write-Info "Downloading $DownloadUrl ..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$OutFile = Join-Path $InstallDir $Binary

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $OutFile -UseBasicParsing
} catch {
    Fail "Download failed: $_`nCheck https://github.com/$Repo/releases/tag/$Version"
}

Write-Info "Installed → $OutFile"

# ── Add to PATH ───────────────────────────────────────────────────────────────
Write-Host ""
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$InstallDir;$UserPath", "User")
    Write-Info "Added $InstallDir to your PATH (User)."
    Write-Warn "Restart your terminal (or run: `$env:PATH = `"$InstallDir;`$env:PATH`") to use magent."
} else {
    Write-Info "$InstallDir already in PATH."
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✅ magent installed!" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start (after restarting terminal):"
Write-Host "    magent --help" -ForegroundColor Cyan
Write-Host ""
Write-Host "  For agent:create / agent:list / login commands, @cloudbase/cli is also needed:"
Write-Host "    npm install -g @cloudbase/cli    (requires Node.js from https://nodejs.org)" -ForegroundColor Cyan
Write-Host ""
Write-Host "────────────────────────────────────────"
Write-Host "Docs: https://github.com/$Repo#readme"
Write-Host ""
