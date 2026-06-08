/**
 * Emparejamiento del agente con el backend.
 *
 * Flujo en cristiano:
 *   1. El cliente entra a tu dashboard y hace clic en "Conectar nuevo escáner".
 *   2. Tu backend genera un código corto de 6-8 caracteres (ej. "K7P-9XQ") que dura 10 minutos.
 *      Ese código está ligado a su cuenta y a esa sesión.
 *   3. El dashboard le muestra al cliente el comando: shs-scanner pair K7P-9XQ
 *   4. El cliente lo ejecuta. El agente llama al backend, "canjea" el código corto por
 *      el token permanente, lo guarda en el archivo de identidad, y queda emparejado.
 *
 * El código corto se quema al usarse. El token permanente NO se manda nunca por canales
 * inseguros — solo viaja una vez, sobre HTTPS, durante el canje.
 */
import { saveConfig, getConfigPath, type AgentConfig } from "./config.js";
import { getSystemInfo } from "./system-info.js";

/** URL del endpoint de canje. Se sobreescribe en compilación o vía variable de entorno. */
const PAIRING_ENDPOINT =
  process.env["SHS_PAIRING_ENDPOINT"] ?? "https://securitysmartservices.site/api/agents/pair";

interface PairResponse {
  agentId: string;
  token: string;
  relayUrl: string;
  orgId: string;
}

export async function pair(pairingCode: string): Promise<AgentConfig> {
  const normalized = pairingCode.trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,16}$/.test(normalized)) {
    throw new Error(
      "Código de emparejamiento inválido. Debe tener entre 6 y 16 caracteres (letras, números o guiones).",
    );
  }

  console.log(`[pair] Canjeando código ${normalized} contra ${PAIRING_ENDPOINT}…`);

  const system = getSystemInfo();

  let response: Response;
  try {
    response = await fetch(PAIRING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: normalized, system }),
    });
  } catch (err) {
    throw new Error(
      `No se pudo contactar al servidor. Revisa tu conexión a internet. Detalle: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (!response.ok) {
    let detail = await response.text();
    try {
      const parsed = JSON.parse(detail) as { error?: string; message?: string };
      detail = parsed.error ?? parsed.message ?? detail;
    } catch {
      /* texto plano */
    }
    if (response.status === 404 || response.status === 410) {
      throw new Error(`El código ${normalized} no es válido o ya expiró. Genera uno nuevo desde el dashboard.`);
    }
    if (response.status === 409) {
      throw new Error(`El código ${normalized} ya fue usado por otro agente.`);
    }
    throw new Error(`Falló el emparejamiento (HTTP ${response.status}): ${detail}`);
  }

  const data = (await response.json()) as PairResponse;
  if (!data.agentId || !data.token || !data.relayUrl || !data.orgId) {
    throw new Error("El servidor respondió con datos incompletos. Contacta soporte.");
  }

  const config: AgentConfig = {
    agentId: data.agentId,
    token: data.token,
    relayUrl: data.relayUrl,
    orgId: data.orgId,
    pairedAt: new Date().toISOString(),
  };

  saveConfig(config);

  console.log(`\n✓ Agente emparejado correctamente.`);
  console.log(`  ID:       ${config.agentId}`);
  console.log(`  Carpeta:  ${getConfigPath()}`);
  console.log(`\nPuedes arrancar el agente con:  shs-scanner start\n`);

  return config;
}
