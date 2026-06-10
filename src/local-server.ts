/**
 * Servidor HTTP local del agente (loopback only: 127.0.0.1).
 *
 * ¿Para qué sirve?
 * --------------------------------------------------------------------
 * El dashboard web (https://securitysmartservices.site) necesita saber,
 * cuando un cliente entra por primera vez a su cuenta, si en ESA MISMA
 * máquina ya hay un agente instalado y corriendo — aunque pertenezca a
 * otra cuenta. El navegador no puede leer el filesystem, así que el
 * agente expone un pequeño endpoint local:
 *
 *   GET  /whoami   -> { ok, agentId, name?, orgId, hostname, version }
 *   POST /repair   -> { pairingCode } reusa pair() para cambiar de dueño
 *
 * Seguridad
 * --------------------------------------------------------------------
 * - Escucha SOLO en 127.0.0.1 (no es alcanzable desde la red).
 * - /whoami devuelve identidad pública (agentId, orgId), nunca el token.
 * - /repair recibe un código de emparejamiento de un solo uso emitido
 *   por el dashboard del usuario autenticado; el agente lo canjea
 *   exactamente como si el usuario lo hubiera tipeado en la terminal.
 * - CORS: solo aceptamos el origin del dashboard de producción y
 *   localhost (para desarrollo). Para que Chrome permita la conexión
 *   desde HTTPS a 127.0.0.1, respondemos al preflight con el header
 *   `Access-Control-Allow-Private-Network: true` (Private Network Access).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";

import type { AgentConfig } from "./config.js";
import { pair } from "./pairing.js";

/** Puerto loopback fijo. Elegido lejos de rangos típicos para no chocar. */
export const LOCAL_PORT = 47878;

const ALLOWED_ORIGINS = new Set<string>([
  "https://securitysmartservices.site",
  "https://www.securitysmartservices.site",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8080",
]);

/** Si el origin viene en la cabecera y está en la allowlist, lo eco; si no, "null". */
function pickOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (typeof origin === "string" && ALLOWED_ORIGINS.has(origin)) return origin;
  return "null";
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", pickOrigin(req));
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Chrome / Edge: PNA — permite que una página HTTPS pública contacte 127.0.0.1.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, limitBytes = 4_096): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Body demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

export interface LocalServerOptions {
  /** Versión del agente para incluir en /whoami */
  version: string;
  /** Devuelve la identidad ACTUAL (puede cambiar tras un /repair) */
  getConfig: () => AgentConfig | null;
  /** Notifica que la identidad cambió (el caller debe reconectar el relay) */
  onRepaired: (newConfig: AgentConfig) => void | Promise<void>;
}

/**
 * Levanta el servidor local. Devuelve una función para apagarlo limpio.
 * Es totalmente no-bloqueante: si el puerto está ocupado, loggea y sigue
 * (el agente arranca igual; simplemente la detección no funcionará en
 * esta ejecución).
 */
export function startLocalServer(opts: LocalServerOptions): () => void {
  const server = createServer(async (req, res) => {
    setCors(req, res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = req.url ?? "/";
    const path = url.split("?")[0];

    try {
      if (req.method === "GET" && path === "/whoami") {
        const config = opts.getConfig();
        if (!config) {
          sendJson(res, 200, { ok: false, paired: false, version: opts.version });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          paired: true,
          agentId: config.agentId,
          orgId: config.orgId,
          hostname: hostname(),
          version: opts.version,
          pairedAt: config.pairedAt,
        });
        return;
      }

      if (req.method === "POST" && path === "/repair") {
        const body = (await readJsonBody(req)) as { pairingCode?: unknown };
        const code = typeof body.pairingCode === "string" ? body.pairingCode : "";
        if (!code) {
          sendJson(res, 400, { ok: false, error: "Falta pairingCode" });
          return;
        }
        const newConfig = await pair(code);
        await opts.onRepaired(newConfig);
        sendJson(res, 200, {
          ok: true,
          agentId: newConfig.agentId,
          orgId: newConfig.orgId,
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Ruta no encontrada" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error interno";
      sendJson(res, 500, { ok: false, error: message });
    }
  });

  server.on("error", (err) => {
    // Si el puerto está ocupado (EADDRINUSE) o no hay permisos, NO mates al
    // agente — simplemente no habrá detección en esta ejecución.
    console.warn(`[local-server] No se pudo arrancar en 127.0.0.1:${LOCAL_PORT}: ${err.message}`);
  });

  server.listen(LOCAL_PORT, "127.0.0.1", () => {
    console.log(`[local-server] Escuchando en http://127.0.0.1:${LOCAL_PORT}`);
  });

  return () => {
    server.close();
  };
}
