# S.S.S Scanner Agent

Agente local open-source que ejecuta escaneos de red para [Security Smart Services](https://securitysmartservices.site).

Corre en **tu máquina, dentro de tu red**, recibe órdenes desde el dashboard de S.S.S y devuelve los resultados. S.S.S nunca tiene acceso directo a tu red — el agente es la única pieza con permisos para escanearla, y tú lo controlas.

## ¿Por qué un agente local?

Para auditar la seguridad de una red privada hay que estar *dentro* de esa red. Un servicio en la nube no puede llegar a tus dispositivos detrás del router. Este agente vive en una de tus máquinas (tu PC, un mini-PC, un servidor casero) y ejecuta los escaneos por ti.

## Garantías

- **Open source (MIT)** — puedes leer cada línea de código o compilarlo tú mismo.
- **Solo conexiones salientes** — no abre puertos, no necesita reglas de firewall especiales.
- **Tu identidad, tu agente** — el token está ligado a tu cuenta. Si cancelas la suscripción o desinstalas, el agente deja de funcionar.
- **Lista blanca de comandos** — el agente solo ejecuta flags de nmap previamente aprobados, aunque el backend fuera comprometido.

## Instalación

### Windows

Abre PowerShell como Administrador y pega:

```powershell
iwr https://securitysmartservices.site/install.ps1 | iex
```

### macOS / Linux

Abre Terminal y pega:

```bash
curl -fsSL https://securitysmartservices.site/install.sh | sh
```

### Manual

Descarga el binario para tu sistema desde [Releases](https://github.com/<tu-org>/shs-scanner-agent/releases).

## Uso

```bash
# Empareja con tu cuenta (genera el código en el dashboard)
shs-scanner pair K7P-9XQ

# Arranca el agente
shs-scanner start

# Diagnóstico (chequea nmap, conectividad, emparejamiento)
shs-scanner doctor

# Estado
shs-scanner status

# Desconectar y borrar identidad
shs-scanner unpair
```

## Requisitos

- [nmap](https://nmap.org/download) instalado en el sistema
- Conexión a internet saliente sobre HTTPS/WSS (puerto 443)

En Windows, ejecuta como Administrador para tener escaneo ARP completo.

## Dónde se guarda la identidad

| Sistema | Ruta |
|---------|------|
| Windows | `%LOCALAPPDATA%\shs-scanner\agent.json` |
| macOS   | `~/.config/shs-scanner/agent.json` |
| Linux   | `~/.config/shs-scanner/agent.json` |

Borrar ese archivo o ejecutar `shs-scanner unpair` desconecta el agente de tu cuenta.

## Compilar desde fuente

```bash
git clone https://github.com/<tu-org>/shs-scanner-agent
cd shs-scanner-agent
npm install
npm run build
npm run start -- doctor
```

Para generar los binarios distribuibles:

```bash
npm run package:all
# Salen en build/
```

## Licencia

MIT — ver `LICENSE`.
