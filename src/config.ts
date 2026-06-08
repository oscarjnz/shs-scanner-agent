/**
 * Configuración del agente.
 *
 * El agente guarda su "carnet de identidad" en un archivo .shs-agent.json
 * en la carpeta del usuario. Ese archivo contiene:
 *   - agentId:   identificador único de este agente (lo da el backend al emparejarlo)
 *   - token:     clave secreta firmada por el backend, ligada a la cuenta del cliente
 *   - relayUrl:  WebSocket del relay (puede cambiar si migramos servidor)
 *   - orgId:     a qué organización pertenece (para el dashboard)
 *
 * Si el cliente borra ese archivo o tú revocas el token desde tu dashboard,
 * el agente deja de funcionar. Esto es a propósito: el cliente es dueño de su agente.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Carpeta donde vive el archivo de identidad, según el SO */
function getConfigDir(): string {
  // En Windows: C:\Users\<user>\AppData\Local\shs-scanner
  // En Mac/Linux: ~/.config/shs-scanner
  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "shs-scanner");
  }
  return join(homedir(), ".config", "shs-scanner");
}

const CONFIG_PATH = join(getConfigDir(), "agent.json");

export interface AgentConfig {
  agentId: string;
  token: string;
  relayUrl: string;
  orgId: string;
  /** Cuándo se emparejó por primera vez (ISO) */
  pairedAt: string;
}

/** Lee la identidad del agente si ya está emparejado. `null` si todavía no lo está. */
export function loadConfig(): AgentConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    if (!parsed.agentId || !parsed.token || !parsed.relayUrl || !parsed.orgId) {
      console.error(`[config] Archivo de configuración corrupto en ${CONFIG_PATH}`);
      return null;
    }
    return parsed as AgentConfig;
  } catch (err) {
    console.error(`[config] No se pudo leer ${CONFIG_PATH}:`, err);
    return null;
  }
}

/** Guarda la identidad del agente la primera vez que se empareja. */
export function saveConfig(config: AgentConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`[config] Identidad guardada en ${CONFIG_PATH}`);
}

/** Ruta del archivo (útil para mostrarle al cliente dónde está su credencial). */
export function getConfigPath(): string {
  return CONFIG_PATH;
}
