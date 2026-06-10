<#
.SYNOPSIS
  S.S.S Scanner Agent - Instalador para Windows

.DESCRIPTION
  Uso tipico (el cliente abre PowerShell como Administrador y pega):

    iwr https://securitysmartservices.site/install.ps1 | iex

  Detecta arquitectura, descarga el binario correcto, lo coloca en Program Files,
  agrega al PATH, registra Windows Service para arrancarlo al boot, y verifica nmap.

.PARAMETER InstallDir
  Carpeta de instalacion. Default: $env:ProgramFiles\SHS Scanner

.PARAMETER Version
  Tag de release de GitHub. Default: latest

.PARAMETER NoService
  Si esta presente, NO registra el Windows Service.

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

# ─── Helpers de output (ASCII puro para evitar problemas de encoding) ────
function Write-Step    { param($Msg) Write-Host "[*] $Msg" -ForegroundColor Cyan }
function Write-Success { param($Msg) Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Warn    { param($Msg) Write-Host "[!] $Msg" -ForegroundColor Yellow }
function Write-Err     { param($Msg) Write-Host "[X] $Msg" -ForegroundColor Red }

# ─── Validar privilegios de administrador ─────────────────────────
function Test-Administrator {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  Write-Err "Este instalador necesita PowerShell como Administrador."
  Write-Host ""
  Write-Host "  Cierra esta ventana y abre PowerShell asi:"
  Write-Host "    1) Tecla Windows -> escribe 'PowerShell'"
  Write-Host "    2) Clic derecho -> 'Ejecutar como administrador'"
  Write-Host "    3) Vuelve a pegar el comando de instalacion"
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
    Write-Warn "nmap no esta instalado. Sin el, el escaner no podra auditar tu red."
    Write-Host ""
    Write-Host "  Como instalarlo:" -ForegroundColor White
    Write-Host "    Opcion A (recomendada): descarga oficial"
    Write-Host "       https://nmap.org/download"
    Write-Host "    Opcion B (con winget):"
    Write-Host "       winget install Insecure.Nmap"
    Write-Host "    Opcion C (con chocolatey):"
    Write-Host "       choco install nmap -y"
    Write-Host ""
    Write-Host "  Importante:" -ForegroundColor Yellow
    Write-Host "    Durante la instalacion de nmap, deja MARCADA la opcion de Npcap."
    Write-Host "    Sin Npcap, los escaneos ARP no funcionaran correctamente."
    Write-Host ""
    Write-Host "  El escaner se instala igual, pero 'shs-scanner doctor' te avisara"
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

  Write-Step "Descargando $asset..."

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
    Write-Err "Verifica tu conexion o consulta https://github.com/$GithubRepo/releases"
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

  # Si ya existe (reinstalacion), detener servicio si lo hay y reemplazar
  if (Test-Path $finalPath) {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq "Running") {
      Write-Step "Deteniendo servicio existente para reemplazar el binario..."
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $finalPath -Force
  }

  Move-Item $tmp $finalPath -Force
  Write-Success "Instalado en $finalPath"
  return $finalPath
}

# ─── Anadir al PATH del sistema (idempotente) ─────────────────────
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
  # Actualizar PATH de la sesion actual tambien
  $env:Path = "$env:Path;$Dir"
  Write-Success "Anadido al PATH del sistema: $Dir"
  Write-Warn "Las ventanas de PowerShell que ya tenias abiertas necesitaran reabrirse."
}

# ─── Tarea programada (arranque automatico permanente) ────────────
# Un .exe de consola NO puede registrarse como Servicio de Windows (no implementa
# el protocolo del SCM y falla con error 1053). Usamos una Tarea Programada que
# corre el agente al iniciar el sistema, como SYSTEM, y lo reinicia si se cae.
function Install-StartupTask {
  param([string]$BinPath)

  if ($NoService) {
    Write-Warn "Saltando registro de la tarea de arranque (-NoService)"
    return
  }

  Write-Step "Registrando tarea de arranque '$ServiceName'..."

  # Limpiar restos de intentos anteriores (servicio Windows que no funcionaba + tarea)
  $oldSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($oldSvc) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
  }
  Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue

  try {
    $action = New-ScheduledTaskAction -Execute $BinPath -Argument "start"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings -Description "Agente local de Security Smart Services" -Force | Out-Null
  } catch {
    Write-Err "No se pudo crear la tarea de arranque: $($_.Exception.Message)"
    return
  }

  Write-Success "Tarea de arranque '$ServiceName' creada (corre al encender la PC, como SYSTEM)."
  Write-Host ""
  Write-Host "  Para arrancarla AHORA (tras emparejar):" -ForegroundColor White
  Write-Host "    Start-ScheduledTask -TaskName $ServiceName"
  Write-Host ""
  Write-Host "  Para ver su estado:" -ForegroundColor White
  Write-Host "    Get-ScheduledTask -TaskName $ServiceName | Get-ScheduledTaskInfo"
}

# ─── Pantalla final ───────────────────────────────────────────────
function Show-NextSteps {
  param([string]$BinPath)

  Write-Host ""
  Write-Host "[OK] Instalacion completada." -ForegroundColor Green
  Write-Host ""
  Write-Host "Proximos pasos:" -ForegroundColor White
  Write-Host ""
  Write-Host "  1. Genera un codigo de emparejamiento en tu dashboard de S.S.S:"
  Write-Host "     https://securitysmartservices.site/settings/scanners" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  2. Empareja este agente con tu cuenta:"
  Write-Host "     shs-scanner pair <codigo>" -ForegroundColor White
  Write-Host ""
  Write-Host "  3. Verifica todo con el diagnostico:"
  Write-Host "     shs-scanner doctor" -ForegroundColor White
  Write-Host ""
  Write-Host "  4. Arranca el agente en segundo plano (o reinicia tu PC y arranca solo):"
  Write-Host "     Start-ScheduledTask -TaskName $ServiceName" -ForegroundColor White
  Write-Host ""
  Write-Host "  Para desinstalar en cualquier momento:" -ForegroundColor DarkGray
  Write-Host "     iwr https://securitysmartservices.site/uninstall.ps1 | iex" -ForegroundColor DarkGray
  Write-Host ""
}

# Crea la carpeta de identidad COMPARTIDA (ProgramData) con permisos para que
# tanto el usuario (al emparejar) como el servicio (cuenta Sistema) la usen.
function Initialize-ConfigDir {
  $dir = Join-Path $env:ProgramData "shs-scanner"
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  try {
    $acl = Get-Acl $dir
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      "BUILTIN\Users", "Modify", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.AddAccessRule($rule)
    Set-Acl -Path $dir -AclObject $acl
  } catch {
    Write-Warn "No se pudieron ajustar permisos de $dir (continuo igual)."
  }
  Write-Success "Carpeta de identidad lista: $dir"
}

# ─── Main ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "S.S.S Scanner Agent - Instalador" -ForegroundColor White
Write-Host ""

$arch = Get-Arch
Write-Step "Sistema detectado: Windows / $arch"

Test-Nmap | Out-Null

$binPath = Get-Binary -Arch $arch
Add-ToPath -Dir $InstallDir
Initialize-ConfigDir
Install-StartupTask -BinPath $binPath
Show-NextSteps -BinPath $binPath
