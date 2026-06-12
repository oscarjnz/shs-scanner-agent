/**
 * Cliente WebSocket que conecta el agente con el backend en la nube ("relay").
 *
 * Cómo funciona en cristiano:
 *   1. El agente abre una llamada permanente al servidor (saliente, sin puertos abiertos).
 *   2. Se identifica con su token y le cuenta al server qué máquina es.
 *   3. El server le manda mensajes tipo {"type":"scan","target":"192.168.1.0/24"}.
 *   4. El agente ejecuta y devuelve {"type":"scan_result", ...}.
 *   5. Si la conexión se cae (Wi-Fi muere, cliente cierra laptop, etc.) reconecta sola.
 */
import WebSocket from "ws";
import type { AgentConfig } from "./config.js";
import { getSystemInfo } from "./system-info.js";

/** Mensajes que el agente RECIBE del backend */
export type InboundMessage =
  | { type: "ping" }
  | { type: "scan_request"; jobId: string; target: string; nmapArgs: string[] }
  | { type: "cancel"; jobId: string }
  | { type: "shutdown" }
  | { type: "ack"; message?: string };

/** Mensajes que el agente ENVÍA al backend */
export type OutboundMessage =
  | { type: "hello"; agentVersion: string; system: ReturnType<typeof getSystemInfo> }
  | { type: "pong" }
  | { type: "scan_progress"; jobId: string; message: string }
  | { type: "scan_result"; jobId: string; rawOutput: string; durationMs: number }
  | { type: "scan_error"; jobId: string; message: string };

export interface RelayHandlers {
  onScanRequest: (jobId: string, target: string, nmapArgs: string[]) => Promise<void>;
  onCancel: (jobId: string) => void;
}

const AGENT_VERSION = "0.1.0";
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly handlers: RelayHandlers,
  ) {}

  connect(): void {
    if (this.shuttingDown) return;

    // El token se manda en el header Authorization, no en la URL,
    // para que no quede en logs accidentalmente.
    this.ws = new WebSocket(this.config.relayUrl, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "X-Agent-Id": this.config.agentId,
        "X-Agent-Version": AGENT_VERSION,
      },
    });

    this.ws.on("open", () => {
      console.log(`[relay] Conectado al backend (${this.config.relayUrl})`);
      this.reconnectAttempts = 0;
      this.send({
        type: "hello",
        agentVersion: AGENT_VERSION,
        system: getSystemInfo(),
      });
      this.startHeartbeat();
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      let msg: InboundMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn("[relay] Mensaje no-JSON ignorado");
        return;
      }
      this.handleMessage(msg);
    });

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason.toString() || "";
      console.warn(`[relay] Conexión cerrada (${code}) ${reasonStr}`);
      this.cleanupHeartbeat();

      // Si el relay nos cerró porque OTRA instancia con el mismo agentId
      // se conectó, NO reconectes: vas a entrar en un ping-pong infinito
      // peleándote con la otra instancia. Sal con un mensaje claro para
      // que el usuario sepa qué pasa.
      // El backend manda code 1000 con motivo "Reemplazado por nueva conexión"
      // (o "replaced"); matcheamos flexible por si cambia la redacción.
      const lower = reasonStr.toLowerCase();
      if (lower.includes("reemplazad") || lower.includes("replaced") || lower.includes("duplicate")) {
        console.error(
          "\n[relay] Otra instancia de shs-scanner con la misma identidad se conectó al relay y nos desplazó.\n" +
          "       Casi siempre esto significa que el servicio del sistema (launchd/systemd) ya está\n" +
          "       corriendo y tú lanzaste 'shs-scanner start' a mano. Sólo puede haber UNA instancia\n" +
          "       activa por agente.\n\n" +
          "       Qué hacer:\n" +
          "         • macOS:   launchctl bootout gui/$(id -u)/com.shs.scanner    # para el servicio\n" +
          "                    launchctl print gui/$(id -u)/com.shs.scanner       # para ver si está corriendo\n" +
          "         • Linux:   sudo systemctl stop shs-scanner\n" +
          "                    systemctl status shs-scanner                       # para ver si está corriendo\n",
        );
        this.shuttingDown = true;
        // Pequeña pausa para que los logs salgan antes de que el proceso muera.
        setTimeout(() => process.exit(2), 100);
        return;
      }

      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[relay] Error de WebSocket:", err.message);
      // 'close' va a dispararse después, ahí reintentamos
    });
  }

  send(msg: OutboundMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn(`[relay] Drop de mensaje (socket no abierto): ${msg.type}`);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.cleanupHeartbeat();
    this.ws?.close(1000, "Agent shutdown");
  }

  private handleMessage(msg: InboundMessage): void {
    switch (msg.type) {
      case "ping":
        this.send({ type: "pong" });
        break;
      case "scan_request":
        console.log(`[relay] Job ${msg.jobId}: ${msg.target}`);
        // No await aquí: queremos seguir leyendo más mensajes en paralelo
        this.handlers.onScanRequest(msg.jobId, msg.target, msg.nmapArgs).catch((err) => {
          this.send({
            type: "scan_error",
            jobId: msg.jobId,
            message: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      case "cancel":
        this.handlers.onCancel(msg.jobId);
        break;
      case "shutdown":
        console.log("[relay] El backend pidió apagar el agente");
        this.shutdown();
        process.exit(0);
        break;
      case "ack":
        if (msg.message) console.log(`[relay] ${msg.message}`);
        break;
    }
  }

  private startHeartbeat(): void {
    this.cleanupHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // ws.ping() es un frame nativo de WebSocket, distinto al "ping" lógico
        this.ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private cleanupHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    // Backoff exponencial: 2s, 4s, 8s, 16s, 32s, 60s, 60s...
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    console.log(`[relay] Reintentando en ${Math.round(delay / 1000)}s (intento ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }
}
