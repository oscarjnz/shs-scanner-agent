<#
.SYNOPSIS
  S.S.S Scanner Agent - Desinstalador para Windows

.DESCRIPTION
  Quita: Windows Service, binario, entrada del PATH, y configuración.

  Uso:
    iwr https://securitysmartservices.site/uninstall.ps1 | iex

.PARAMETER InstallDir
  Default: $env:ProgramFiles\SHS Scanner

.PARAMETER KeepIdentity
  Si está presente, NO borra la carpeta de configuración (por si reinstalas pronto).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:ProgramFiles\SHS Scanner",
  [switch]$KeepIdentity
)

$ErrorActionPreference = "Continue"
$BinName = "shs-scanner.exe"
$ServiceName = "SHSScanner"
$ConfigDir = Join-Path $env:LOCALAPPDATA "shs-scanner"

function Write-Step    { param($Msg) Write-Host "▸ $Msg" -ForegroundColor Cyan }
function Write-Success { param($Msg) Write-Host "✓ $Msg" -ForegroundColor Green }
function Write-Warn    { param($Msg) Write-Host "⚠  $Msg" -ForegroundColor Yellow }
function Write-Err     { param($Msg) Write-Host "✗ $Msg" -ForegroundColor Red }

# ─── Requiere Administrador ───────────────────────────────────────
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Err "Este desinstalador necesita PowerShell como Administrador."
  exit 1
}

# ─── 1) Detener y borrar el servicio ─────────────────────────────
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Write-Step "Deteniendo Windows Service '$ServiceName'…"
  if ($svc.Status -eq "Running") {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  }
  & sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 1
  Write-Success "Servicio eliminado"
}

# ─── 2) Matar cualquier proceso huérfano ─────────────────────────
Get-Process | Where-Object { $_.Path -eq (Join-Path $InstallDir $BinName) } |
  ForEach-Object {
    Write-Step "Cerrando proceso pid=$($_.Id)…"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }

# ─── 3) Borrar binario y carpeta de instalación ──────────────────
if (Test-Path $InstallDir) {
  Write-Step "Borrando $InstallDir…"
  Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) {
    Write-Warn "No se pudo borrar $InstallDir (puede que un proceso siga usándolo)"
  } else {
    Write-Success "Carpeta de instalación eliminada"
  }
}

# ─── 4) Quitar del PATH del sistema ──────────────────────────────
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$entries = $machinePath -split ";" | Where-Object { $_ -ne "" -and $_ -ne $InstallDir }
$newPath = $entries -join ";"
if ($newPath -ne $machinePath) {
  [Environment]::SetEnvironmentVariable("Path", $newPath, "Machine")
  Write-Success "Quitado del PATH del sistema"
}

# ─── 5) Borrar configuración / identidad ─────────────────────────
if ($KeepIdentity) {
  Write-Warn "Conservando identidad en $ConfigDir (-KeepIdentity)"
} elseif (Test-Path $ConfigDir) {
  Write-Step "Borrando configuración $ConfigDir…"
  Remove-Item -Path $ConfigDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Success "Configuración eliminada"
}

Write-Host ""
Write-Host "✓ Desinstalación completada." -ForegroundColor Green
Write-Host ""
Write-Host "  Si quieres revocar este agente de tu cuenta también:"
Write-Host "    Ve a https://securitysmartservices.site/settings/scanners"
Write-Host "    y haz clic en el icono de basura del agente."
Write-Host ""
