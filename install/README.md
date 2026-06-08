# Scripts de instalación

Estos 4 scripts son los que el cliente descarga y ejecuta para instalar / desinstalar
el agente en su máquina.

| Script | OS | Acción |
|---|---|---|
| `install.sh`   | macOS, Linux | Instalar agente |
| `install.ps1`  | Windows      | Instalar agente |
| `uninstall.sh` | macOS, Linux | Desinstalar |
| `uninstall.ps1`| Windows      | Desinstalar |

## ⚠️ Cómo se distribuyen al cliente

Estos archivos **NO se descargan desde GitHub** — el cliente jamás navega a un repo.
Tienen que estar disponibles directamente en `securitysmartservices.site`, así:

| URL pública | Sirve el archivo |
|---|---|
| `https://securitysmartservices.site/install.sh`     | este `install.sh` |
| `https://securitysmartservices.site/install.ps1`    | este `install.ps1` |
| `https://securitysmartservices.site/uninstall.sh`   | este `uninstall.sh` |
| `https://securitysmartservices.site/uninstall.ps1`  | este `uninstall.ps1` |

Vías para servirlos (elige UNA):

### Opción A — Carpeta `public/` del dashboard Vite (la más fácil)

Copia los 4 archivos a `src/../public/`. Vite los sirve tal cual en la raíz del dominio.
Cada `npm run build && vercel deploy` los publica.

### Opción B — Endpoints de Vercel que los devuelvan como texto

Crea `api/install.ts`, `api/install.ps1.ts`, etc., que hagan `res.setHeader("Content-Type", "text/plain")`
y devuelvan el contenido. Útil si quieres parametrizar el script según el cliente.

### Opción C — Bucket S3 / R2 con CDN

Súbelos a Cloudflare R2 o S3 con CORS público y pon un redirect 301 desde `/install.sh`
en Vercel hacia el bucket.

## Probar localmente

```bash
# Desde el agente compilado, en macOS/Linux:
SHS_GITHUB_REPO=oscartronico1420/shs-scanner-agent \
SHS_INSTALL_DIR=$HOME/.local/bin \
SHS_NO_SERVICE=1 \
sh install.sh

# En Windows (PowerShell admin):
.\install.ps1 -InstallDir "$env:USERPROFILE\bin" -NoService
```

## Variables que el script respeta

### install.sh

| Var | Default | Para qué |
|---|---|---|
| `SHS_INSTALL_DIR` | `/usr/local/bin` | Dónde poner el binario |
| `SHS_VERSION`     | `latest`         | Tag específico (`v0.1.0`) |
| `SHS_NO_SERVICE`  | `0`              | `1` para no registrar systemd/launchd |
| `SHS_GITHUB_REPO` | `oscartronico1420/shs-scanner-agent` | Override del repo |

### install.ps1

| Parámetro | Default | Para qué |
|---|---|---|
| `-InstallDir` | `$env:ProgramFiles\SHS Scanner` | Dónde poner el binario |
| `-Version`    | `latest` | Tag específico |
| `-NoService`  | (switch) | Si está, no registra Windows Service |
| `-GithubRepo` | `oscartronico1420/shs-scanner-agent` | Override del repo |
