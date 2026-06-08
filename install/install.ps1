<#
.SYNOPSIS
  S.S.S Scanner Agent - Instalador para Windows

.DESCRIPTION
  Uso típico (el cliente abre PowerShell como Administrador y pega):

    iwr https://securitysmartservices.site/install.ps1 | iex

  Detecta arquitectura, descarga el binario correcto, lo coloca en Program Files,
  agrega al PATH, registra Windows Service para arrancarlo al boot, y verifica nmap.

.PARAMETER InstallDir
  Carpeta de instalación. Default: $env:ProgramFiles\SHS Scanner

.PARAMETER Version
  Tag de release de GitHub. Default: latest

.PARAMETER NoService
  Si está presente, NO registra el Windows Service.

.PARAMETER GithubRepo
  Repo en formato owner/name. Default: oscarjnz/shs-scanner-agent
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:ProgramFiles\SHS Scanner",
  [string]$Version = "latest",
  [switch]$NoService,
  [string]$GithubRepo = "oscarjnz/shs-scanner-agent"
)

$ErrorActionPreference = "Stop"
$BinName = "shs-scanner.exe"
$ServiceName = "SHSScanner"

# ─── Helpers de output ─────────────────────────────────────────────
function Write-Step    { param($Msg) Write-Host "▸ $Msg" -ForegroundColor Cyan }
function Write-Success { param($Msg) Write-Host "✓ $Msg" -ForegroundColor Green }
function Write-Warn    { param($Msg) Write-Host "⚠  $Msg" -ForegroundColor Yellow }
function Write-Err     { param($Msg) Write-Host "✗ $Msg" -ForegroundColor Red }

# ─── Validar privilegios de administrador ─────────────────────────
function Test-Administrator {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  Write-Err "Este instalador necesita PowerShell como Administrador."
  Write-Host ""
  Write-Host "  Cierra esta ventana y abre PowerShell así:"
  Write-Host "    1) Tecla Windows → escribe 'PowerShell'"
  Write-Host "    2) Clic derecho → 'Ejecutar como administrador'"
  Write-Host "    3) Vuelve a pegar el comando de instalación"
  Write-Host ""
  exit 1
}

# ─── Detectar arquitectura ────────────────────────────────────────
function Get-Arch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  switch ($arch) {
    "AMD64" { return "x64" }
    "ARM64" { return "arm64" }
    default {
      Write-Err "Arquitectura no soportada: $arch"
      exit 1
    }
  }
}

# ─── Verificar nmap ───────────────────────────────────────────────
function Test-Nmap {
  try {
    $nmapPath = (Get-Command nmap -ErrorAction Stop).Source
    $version = & nmap --version 2>&1 | Select-Object -First 1
    Write-Success "nmap detectado: $version"
    return $true
  } catch {
    Write-Warn "nmap no está instalado. Sin él, el escáner no podrá auditar tu red."
    Write-Host ""
    Write-Host "  Cómo instalarlo:" -ForegroundColor White
    Write-Host "    Opción A (recomendada): descarga oficial"
    Write-Host "       https://nmap.org/download"
    Write-Host "    Opción B (con winget):"
    Write-Host "       winget install Insecure.Nmap"
    Write-Host "    Opción C (con chocolatey):"
    Write-Host "       choco install nmap -y"
    Write-Host ""
    Write-Host "  Importante:" -ForegroundColor Yellow
    Write-Host "    Durante la instalación de nmap, deja MARCADA la opción de Npcap."
    Write-Host "    Sin Npcap, los escaneos ARP no funcionarán correctamente."
    Write-Host ""
    Write-Host "  El escáner se instala igual, pero 'shs-scanner doctor' te avisará"
    Write-Host "  hasta que tengas nmap funcionando."
    Write-Host ""
    return $false
  }
}

# ─── Descargar binario ────────────────────────────────────────────
function Get-Binary {
  param([string]$Arch)

  $asset = "shs-scanner-windows-$Arch.exe"
  if ($Version -eq "latest") {
    $url = "https://github.com/$GithubRepo/releases/latest/download/$asset"
  } else {
    $url = "https://github.com/$GithubRepo/releases/download/$Version/$asset"
  }

  Write-Step "Descargando $asset…"

  $tmp = New-TemporaryFile
  try {
    # ProgressPreference=SilentlyContinue acelera Invoke-WebRequest en PowerShell 5
    $previousPP = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
      Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    } finally {
      $ProgressPreference = $previousPP
    }
  } catch {
    Write-Err "No se pudo descargar de $url"
    Write-Err "Detalle: $($_.Exception.Message)"
    Write-Err "Verifica tu conexión o consulta https://github.com/$GithubRepo/releases"
    Remove-Item $tmp -ErrorAction SilentlyContinue
    exit 1
  }

  # Verificar que el binario se ejecuta
  try {
    $null = & $tmp version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
  } catch {
    Write-Err "El binario descargado no se ejecuta. Puede estar corrupto."
    Remove-Item $tmp -ErrorAction SilentlyContinue
    exit 1
  }

  # Crear carpeta y mover binario
  if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  }

  $finalPath = Join-Path $InstallDir $BinName

  # Si ya existe (reinstalación), detener servicio si lo hay y reemplazar
  if (Test-Path $finalPath) {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq "Running") {
      Write-Step "Deteniendo servicio existente para reemplazar el binario…"
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $finalPath -Force
  }

  Move-Item $tmp $finalPath -Force
  Write-Success "Instalado en $finalPath"
  return $finalPath
}

# ─── Añadir al PATH del sistema (idempotente) ─────────────────────
function Add-ToPath {
  param([string]$Dir)

  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $entries = $machinePath -split ";" | Where-Object { $_ -ne "" }

  if ($entries -contains $Dir) {
    Write-Success "$Dir ya estaba en el PATH del sistema"
    return
  }

  $newPath = ($entries + $Dir) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "Machine")
  # Actualizar PATH de la sesión actual también
  $env:Path = "$env:Path;$Dir"
  Write-Success "Añadido al PATH del sistema: $Dir"
  Write-Warn "Las ventanas de PowerShell que ya tenías abiertas necesitarán reabrirse."
}

# ─── Windows Service ──────────────────────────────────────────────
function Install-WindowsService {
  param([string]$BinPath)

  if ($NoService) {
    Write-Warn "Saltando registro de Windows Service (-NoService)"
    return
  }

  Write-Step "Registrando Windows Service '$ServiceName'…"

  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.Status -eq "Running") {
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    # Borrar servicio anterior y recrearlo (más simple que sc.exe config)
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
  }

  # Crear servicio con sc.exe (más confiable que New-Service en versiones viejas)
  $exec = "`"$BinPath`" start"
  & sc.exe create $ServiceName binPath= $exec start= auto DisplayName= "S.S.S Scanner Agent" | Out-Null

  if ($LASTEXITCODE -ne 0) {
    Write-Err "No se pudo crear el servicio (sc.exe exit $LASTEXITCODE)"
    return
  }

  & sc.exe description $ServiceName "Agente local de Security Smart Services que ejecuta escaneos de red bajo demanda." | Out-Null
  # Reinicio automático: 1er fallo a los 10s, 2do a los 30s, 3er a los 60s
  & sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null

  Write-Success "Servicio '$ServiceName' creado."
  Write-Host ""
  Write-Host "  Para arrancarlo:" -ForegroundColor White
  Write-Host "    Start-Service $ServiceName"
  Write-Host ""
  Write-Host "  Para ver su estado:" -ForegroundColor White
  Write-Host "    Get-Service $ServiceName"
  Write-Host ""
  Write-Host "  NOTA: arrancar el servicio AHORA fallará si todavía no emparejaste"
  Write-Host "        este agente. Empareja primero (paso 2 de abajo) y luego inicia."
}

# ─── Pantalla final ───────────────────────────────────────────────
function Show-NextSteps {
  param([string]$BinPath)

  Write-Host ""
  Write-Host "✓ Instalación completada." -ForegroundColor Green
  Write-Host ""
  Write-Host "Próximos pasos:" -ForegroundColor White
  Write-Host ""
  Write-Host "  1. Genera un código de emparejamiento en tu dashboard de S.S.S:"
  Write-Host "     https://securitysmartservices.site/settings/scanners" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  2. Empareja este agente con tu cuenta:"
  Write-Host "     shs-scanner pair <código>" -ForegroundColor White
  Write-Host ""
  Write-Host "  3. Verifica todo con el diagnóstico:"
  Write-Host "     shs-scanner doctor" -ForegroundColor White
  Write-Host ""
  Write-Host "  4. Arranca el servicio (o reinicia tu PC y arrancará solo):"
  Write-Host "     Start-Service $ServiceName" -ForegroundColor White
  Write-Host ""
  Write-Host "  Para desinstalar en cualquier momento:" -ForegroundColor DarkGray
  Write-Host "     iwr https://securitysmartservices.site/uninstall.ps1 | iex" -ForegroundColor DarkGray
  Write-Host ""
}

# ─── Main ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "S.S.S Scanner Agent — Instalador" -ForegroundColor White
Write-Host ""

$arch = Get-Arch
Write-Step "Sistema detectado: Windows / $arch"

Test-Nmap | Out-Null

$binPath = Get-Binary -Arch $arch
Add-ToPath -Dir $InstallDir
Install-WindowsService -BinPath $binPath
Show-NextSteps -BinPath $binPath
