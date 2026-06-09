#!/usr/bin/env bash
#
# S.S.S Scanner Agent - Desinstalador para macOS y Linux
# ──────────────────────────────────────────────────────
# Borra todo: binario, servicio, identidad, logs.
#
#   curl -fsSL https://securitysmartservices.site/uninstall.sh | sh
#
# Variables:
#   SHS_INSTALL_DIR        Default: /usr/local/bin
#   SHS_KEEP_IDENTITY=1    Conserva la carpeta ~/.config/shs-scanner (por si reinstalas)
#
set -e

INSTALL_DIR="${SHS_INSTALL_DIR:-/usr/local/bin}"
BIN_NAME="shs-scanner"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m'); BLUE=$(printf '\033[34m'); RESET=$(printf '\033[0m')
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; BLUE=""; RESET=""
fi

step()    { printf "${BLUE}>${RESET} %s\n" "$1"; }
success() { printf "${GREEN}OK${RESET} %s\n" "$1"; }
warn()    { printf "${YELLOW}!${RESET}  %s\n" "$1"; }

OS=$(uname -s | tr '[:upper:]' '[:lower:]')

SUDO=""
if [ ! -w "$INSTALL_DIR" ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# ─── 1) Parar y borrar servicio del sistema ──────────────────────
if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q "^shs-scanner.service"; then
    step "Deteniendo y desactivando servicio systemd..."
    $SUDO systemctl disable --now shs-scanner.service 2>/dev/null || true
    $SUDO rm -f /etc/systemd/system/shs-scanner.service
    $SUDO systemctl daemon-reload
    success "Servicio systemd eliminado"
  fi
elif [ "$OS" = "darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.shs.scanner.plist"
  if [ -f "$PLIST" ]; then
    step "Descargando servicio launchd..."
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    success "Servicio launchd eliminado"
  fi
fi

# ─── 2) Borrar binario ───────────────────────────────────────────
if [ -f "$INSTALL_DIR/$BIN_NAME" ]; then
  step "Borrando binario $INSTALL_DIR/$BIN_NAME..."
  $SUDO rm -f "$INSTALL_DIR/$BIN_NAME"
  success "Binario eliminado"
fi

# ─── 3) Borrar identidad y logs (a menos que el usuario los conserve) ─
CONFIG_DIR="$HOME/.config/shs-scanner"
if [ "${SHS_KEEP_IDENTITY:-0}" = "1" ]; then
  warn "Conservando identidad en $CONFIG_DIR (SHS_KEEP_IDENTITY=1)"
else
  if [ -d "$CONFIG_DIR" ]; then
    step "Borrando carpeta de configuracion $CONFIG_DIR..."
    rm -rf "$CONFIG_DIR"
    success "Configuracion eliminada"
  fi
fi

if [ "$OS" = "darwin" ]; then
  rm -f "$HOME/Library/Logs/shs-scanner.log" "$HOME/Library/Logs/shs-scanner.error.log" 2>/dev/null || true
fi

echo
printf "${GREEN}${BOLD}OK Desinstalacion completada.${RESET}\n"
echo
echo "  Si quieres revocar este agente de tu cuenta tambien:"
echo "    Ve a https://securitysmartservices.site/settings/scanners"
echo "    y haz clic en el icono de basura del agente."
echo
