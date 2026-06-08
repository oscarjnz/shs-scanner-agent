#!/usr/bin/env bash
#
# S.S.S Scanner Agent - Instalador para macOS y Linux
# ────────────────────────────────────────────────────
# Uso típico (el cliente pega esto en su Terminal):
#
#   curl -fsSL https://securitysmartservices.site/install.sh | sh
#
# Variables que puedes setear antes para personalizar:
#   SHS_INSTALL_DIR    Default: /usr/local/bin
#   SHS_VERSION        Default: latest (toma la última release)
#   SHS_NO_SERVICE=1   No registrar como servicio del sistema
#   SHS_GITHUB_REPO    Default: oscarjnz/shs-scanner-agent
#
set -e

GITHUB_REPO="${SHS_GITHUB_REPO:-oscarjnz/shs-scanner-agent}"
INSTALL_DIR="${SHS_INSTALL_DIR:-/usr/local/bin}"
VERSION="${SHS_VERSION:-latest}"
BIN_NAME="shs-scanner"

# ─── Colores ──────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  BLUE=$(printf '\033[34m'); RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

step()    { printf "${BLUE}▸${RESET} %s\n" "$1"; }
success() { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn()    { printf "${YELLOW}⚠${RESET}  %s\n" "$1"; }
err()     { printf "${RED}✗${RESET} %s\n" "$1" >&2; }

cleanup() {
  [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ─── Detección de OS y arquitectura ──────────────────────────────
detect_platform() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)

  case "$os" in
    darwin) OS="macos" ;;
    linux)  OS="linux" ;;
    *)
      err "Sistema operativo no soportado: $os"
      err "Este instalador funciona en macOS y Linux. Para Windows usa install.ps1"
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)
      err "Arquitectura no soportada: $arch"
      exit 1
      ;;
  esac

  # En Mac arm64 sería Apple Silicon; x64 sería Intel
  ASSET="shs-scanner-${OS}-${ARCH}"
  [ "$OS" = "macos" ] && [ "$ARCH" = "x64" ] && ASSET="shs-scanner-macos-x64"
}

# ─── Linux: detectar distribución ────────────────────────────────
detect_distro() {
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO="${ID:-unknown}"
  else
    DISTRO="unknown"
  fi
}

# ─── nmap: chequear instalación, sugerir cómo instalarlo ─────────
check_nmap() {
  if command -v nmap >/dev/null 2>&1; then
    success "nmap detectado: $(nmap --version | head -1)"
    return 0
  fi

  warn "nmap no está instalado. Sin él, el escáner no podrá auditar tu red."
  echo
  echo "  ${BOLD}Cómo instalarlo:${RESET}"
  if [ "$OS" = "macos" ]; then
    echo "    brew install nmap         ${DIM}# requiere Homebrew (brew.sh)${RESET}"
  else
    case "$DISTRO" in
      ubuntu|debian|raspbian)
        echo "    sudo apt update && sudo apt install -y nmap"
        ;;
      fedora|rhel|centos|rocky|almalinux)
        echo "    sudo dnf install -y nmap   ${DIM}# o 'yum install nmap' en sistemas viejos${RESET}"
        ;;
      arch|manjaro|endeavouros)
        echo "    sudo pacman -S --noconfirm nmap"
        ;;
      alpine)
        echo "    sudo apk add nmap"
        ;;
      *)
        echo "    Usa el gestor de paquetes de $DISTRO para instalar 'nmap'"
        ;;
    esac
  fi
  echo
  echo "  El escáner se instala igual, pero el comando ${BOLD}shs-scanner doctor${RESET} te avisará"
  echo "  hasta que tengas nmap funcionando."
  echo
}

# ─── Permisos: necesitamos escribir en INSTALL_DIR ───────────────
ensure_writable() {
  if [ ! -d "$INSTALL_DIR" ]; then
    if [ -w "$(dirname "$INSTALL_DIR")" ]; then
      mkdir -p "$INSTALL_DIR"
    else
      SUDO="sudo"
      $SUDO mkdir -p "$INSTALL_DIR"
    fi
  fi

  if [ -w "$INSTALL_DIR" ]; then
    SUDO=""
  else
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
      step "Necesitamos privilegios de administrador para instalar en $INSTALL_DIR"
    else
      err "No tienes permiso de escritura en $INSTALL_DIR y 'sudo' no está disponible."
      err "Reintenta con SHS_INSTALL_DIR=\$HOME/.local/bin sh install.sh"
      exit 1
    fi
  fi
}

# ─── Descarga del binario ────────────────────────────────────────
download_binary() {
  TMP_DIR=$(mktemp -d)
  local url
  if [ "$VERSION" = "latest" ]; then
    url="https://github.com/${GITHUB_REPO}/releases/latest/download/${ASSET}"
  else
    url="https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/${ASSET}"
  fi

  step "Descargando $ASSET ($([ "$VERSION" = "latest" ] && echo "última versión" || echo "$VERSION"))…"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$TMP_DIR/$BIN_NAME" "$url" || {
      err "No se pudo descargar de $url"
      err "Verifica tu conexión a internet o consulta https://github.com/${GITHUB_REPO}/releases"
      exit 1
    }
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP_DIR/$BIN_NAME" "$url" || {
      err "No se pudo descargar de $url"
      exit 1
    }
  else
    err "Necesitas 'curl' o 'wget' instalado. Ninguno de los dos está disponible."
    exit 1
  fi

  chmod +x "$TMP_DIR/$BIN_NAME"

  # Verificación: chequea que el binario se ejecuta y reporta su versión
  if ! "$TMP_DIR/$BIN_NAME" version >/dev/null 2>&1; then
    err "El binario descargado no se ejecuta correctamente."
    err "Puede ser un problema de arquitectura o un binario corrupto."
    exit 1
  fi

  $SUDO mv "$TMP_DIR/$BIN_NAME" "$INSTALL_DIR/$BIN_NAME"
  success "Instalado en $INSTALL_DIR/$BIN_NAME"
}

# ─── Servicio del sistema (systemd / launchd) ────────────────────
install_systemd_service() {
  local service_file="/etc/systemd/system/shs-scanner.service"
  local current_user="${SUDO_USER:-$USER}"

  step "Registrando servicio systemd…"

  cat <<EOF | $SUDO tee "$service_file" >/dev/null
[Unit]
Description=S.S.S Scanner Agent
Documentation=https://github.com/${GITHUB_REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/${BIN_NAME} start
Restart=on-failure
RestartSec=10
User=${current_user}
StandardOutput=journal
StandardError=journal

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${HOME}/.config/shs-scanner

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  success "Servicio creado en $service_file"
  echo
  echo "  ${BOLD}Para arrancarlo automáticamente al boot:${RESET}"
  echo "    sudo systemctl enable --now shs-scanner"
  echo
  echo "  ${BOLD}Para ver su estado:${RESET}"
  echo "    sudo systemctl status shs-scanner"
  echo "    sudo journalctl -u shs-scanner -f"
}

install_launchd_service() {
  local plist="$HOME/Library/LaunchAgents/com.shs.scanner.plist"
  step "Registrando servicio launchd (usuario)…"
  mkdir -p "$HOME/Library/LaunchAgents"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.shs.scanner</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/${BIN_NAME}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key><true/>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/shs-scanner.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/shs-scanner.error.log</string>
</dict>
</plist>
EOF

  success "Servicio creado en $plist"
  echo
  echo "  ${BOLD}Para activarlo:${RESET}"
  echo "    launchctl load -w $plist"
  echo
  echo "  ${BOLD}Para ver logs:${RESET}"
  echo "    tail -f ~/Library/Logs/shs-scanner.log"
}

install_service() {
  if [ "${SHS_NO_SERVICE:-0}" = "1" ]; then
    warn "Saltando instalación de servicio (SHS_NO_SERVICE=1)"
    return
  fi

  if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
    install_systemd_service
  elif [ "$OS" = "macos" ]; then
    install_launchd_service
  else
    warn "No detecté systemd ni launchd. El agente se instaló pero no como servicio."
    warn "Arráncalo manualmente con: $BIN_NAME start"
  fi
}

# ─── PATH check ──────────────────────────────────────────────────
verify_in_path() {
  if ! command -v "$BIN_NAME" >/dev/null 2>&1; then
    warn "$INSTALL_DIR no parece estar en tu PATH."
    warn "Añádelo a tu shell rc (.bashrc / .zshrc):"
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
    echo
    echo "  O ejecuta el agente con su ruta completa: $INSTALL_DIR/$BIN_NAME"
  fi
}

# ─── Pantalla final con próximos pasos ───────────────────────────
final_instructions() {
  echo
  printf "${GREEN}${BOLD}✓ Instalación completada.${RESET}\n"
  echo
  echo "${BOLD}Próximos pasos:${RESET}"
  echo
  echo "  ${BOLD}1.${RESET} Genera un código de emparejamiento en tu dashboard de S.S.S:"
  echo "     ${DIM}https://securitysmartservices.site/settings/scanners${RESET}"
  echo
  echo "  ${BOLD}2.${RESET} Empareja este agente con tu cuenta:"
  echo "     ${BOLD}$BIN_NAME pair <código>${RESET}"
  echo
  echo "  ${BOLD}3.${RESET} Verifica todo con el diagnóstico:"
  echo "     ${BOLD}$BIN_NAME doctor${RESET}"
  echo
  echo "  ${BOLD}4.${RESET} Arranca el agente (o deja que el servicio lo haga al iniciar):"
  echo "     ${BOLD}$BIN_NAME start${RESET}"
  echo
  echo "  ${DIM}Para desinstalar en cualquier momento:${RESET}"
  echo "     ${DIM}curl -fsSL https://securitysmartservices.site/uninstall.sh | sh${RESET}"
  echo
}

# ─── Main ────────────────────────────────────────────────────────
main() {
  echo
  printf "${BOLD}S.S.S Scanner Agent — Instalador${RESET}\n"
  echo

  detect_platform
  step "Sistema detectado: $OS / $ARCH"

  [ "$OS" = "linux" ] && detect_distro && step "Distribución: $DISTRO"

  check_nmap
  ensure_writable
  download_binary
  install_service
  verify_in_path
  final_instructions
}

main "$@"
