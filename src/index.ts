#!/usr/bin/env node
/**
 * S.S.S Scanner Agent — punto de entrada.
 *
 * Comandos:
 *   shs-scanner pair <código>     Empareja este agente con tu cuenta
 *   shs-scanner start             Arranca el agente (se conecta al backend)
 *   shs-scanner status            Muestra el estado actual
 *   shs-scanner unpair            Borra la identidad (el agente queda "virgen")
 *   shs-scanner doctor            Diagnóstico: chequea nmap, conectividad, permisos
 *   shs-scanner version           Muestra la versión del agente
 */
import { loadConfig, getConfigPath, type AgentConfig } from "./config.js";
import { pair } from "./pairing.js";
import { RelayClient } from "./relay-client.js";
import { runScan, checkNmapInstalled } from "./scanner.js";
import { getSystemInfo } from "./system-info.js";
import { startLocalServer } from "./local-server.js";
import { existsSync, unlinkSync } from "node:fs";
import { VERSION } from "./version.js";

async function cmdPair(code: string | undefined): Promise<void> {
  if (!code) {
    console.error("Uso: shs-scanner pair <código>");
    console.error("\nObtén tu código en el dashboard de S.S.S → Configuración → Conectar escáner");
    process.exit(1);
  }
  try {
    await pair(code);
  } catch (err) {
    console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdStart(): Promise<void> {
  const initialConfig = loadConfig();
  if (!initialConfig) {
    console.error("✗ Este agente no está emparejado.");
    console.error("\nEjecuta primero: shs-scanner pair <código>");
    console.error("Obtén el código desde tu dashboard de S.S.S.");
    process.exit(1);
  }

  // ─── Anti-doble-instancia ────────────────────────────────────────
  // Si el puerto local del agente ya está vivo Y devuelve nuestra misma
  // identidad, significa que el servicio del sistema (launchd / systemd)
  // ya está corriendo. Lanzar otra copia genera un ping-pong infinito en
  // el relay: cada una desplaza a la otra al conectarse. Mejor abortar.
  const existing = await probeLocalAgent();
  if (existing?.agentId === initialConfig.agentId) {
    console.error(`✗ Ya hay otra instancia de shs-scanner corriendo en esta máquina.`);
    console.error(`  Agent ID detectado: ${existing.agentId}`);
    console.error(`  Versión:            ${existing.version ?? "?"}`);
    console.error();
    console.error(`  Si arrancaste el servicio con el instalador, ya está activo en segundo plano.`);
    console.error(`  Para verlo o pararlo:`);
    if (process.platform === "darwin") {
      console.error(`    launchctl print  gui/$(id -u)/com.shs.scanner`);
      console.error(`    launchctl bootout gui/$(id -u)/com.shs.scanner   # parar`);
    } else if (process.platform === "linux") {
      console.error(`    systemctl status shs-scanner`);
      console.error(`    sudo systemctl stop shs-scanner                  # parar`);
    }
    process.exit(1);
  }

  console.log(`S.S.S Scanner Agent v${VERSION}`);
  console.log(`Agent ID: ${initialConfig.agentId}`);
  console.log(`Conectando a: ${initialConfig.relayUrl}\n`);

  // Mantener jobs activos para poder cancelarlos
  const activeJobs = new Map<string, AbortController>();

  // Holder mutable del client: tras un /repair re-conectamos al relay
  // con la nueva identidad; los callbacks usan `clientHolder.current`
  // para enviar siempre por la conexión vigente.
  const clientHolder: { current: RelayClient } = {
    current: buildRelayClient(initialConfig, activeJobs, () => clientHolder.current),
  };
  let currentConfig: AgentConfig = initialConfig;
  clientHolder.current.connect();

  // Servidor local (loopback) para que el dashboard pueda detectar este
  // agente y, si el usuario lo autoriza, transferirlo a otra cuenta.
  const stopLocalServer = startLocalServer({
    version: VERSION,
    getConfig: () => currentConfig,
    onRepaired: (newConfig) => {
      console.log(`[start] Agente re-emparejado a org ${newConfig.orgId}. Reconectando relay…`);
      for (const abort of activeJobs.values()) abort.abort();
      activeJobs.clear();
      clientHolder.current.shutdown();
      currentConfig = newConfig;
      clientHolder.current = buildRelayClient(newConfig, activeJobs, () => clientHolder.current);
      clientHolder.current.connect();
    },
  });

  // Apagar limpio con Ctrl+C
  const shutdown = () => {
    console.log("\nApagando agente…");
    for (const abort of activeJobs.values()) abort.abort();
    stopLocalServer();
    clientHolder.current.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Helper: construye un RelayClient con los handlers de scan/cancel estándar. */
function buildRelayClient(
  config: AgentConfig,
  activeJobs: Map<string, AbortController>,
  /** Lazy getter para acceder a la conexión vigente desde dentro de los callbacks. */
  getCurrent: () => RelayClient,
): RelayClient {
  return new RelayClient(config, {
    onScanRequest: async (jobId, target, nmapArgs) => {
      const abort = new AbortController();
      activeJobs.set(jobId, abort);

      try {
        const result = await runScan(
          target,
          nmapArgs,
          (message) => getCurrent().send({ type: "scan_progress", jobId, message }),
          abort.signal,
        );
        getCurrent().send({
          type: "scan_result",
          jobId,
          rawOutput: result.rawOutput,
          durationMs: result.durationMs,
        });
      } finally {
        activeJobs.delete(jobId);
      }
    },
    onCancel: (jobId) => {
      const abort = activeJobs.get(jobId);
      if (abort) {
        abort.abort();
        activeJobs.delete(jobId);
      }
    },
  });
}

function cmdStatus(): void {
  const config = loadConfig();
  const system = getSystemInfo();

  console.log(`S.S.S Scanner Agent v${VERSION}\n`);
  console.log(`Sistema detectado:`);
  console.log(`  Hostname:       ${system.hostname}`);
  console.log(`  OS:             ${system.osVersion}`);
  console.log(`  Arquitectura:   ${system.arch}`);
  if (system.linuxDistro) console.log(`  Distribución:   ${system.linuxDistro}`);
  console.log(`  CPU:            ${system.cpuCount} núcleos`);
  console.log(`  RAM:            ${system.totalMemoryGB} GB`);
  console.log(`  IPs locales:    ${system.localIps.join(", ") || "ninguna"}`);

  console.log(`\nEmparejamiento:`);
  if (config) {
    console.log(`  Estado:         ✓ Emparejado`);
    console.log(`  Agent ID:       ${config.agentId}`);
    console.log(`  Organización:   ${config.orgId}`);
    console.log(`  Relay:          ${config.relayUrl}`);
    console.log(`  Emparejado el:  ${config.pairedAt}`);
    console.log(`  Carpeta config: ${getConfigPath()}`);
  } else {
    console.log(`  Estado:         ✗ Sin emparejar`);
    console.log(`\n  Ejecuta: shs-scanner pair <código>`);
  }
}

function cmdUnpair(): void {
  const path = getConfigPath();
  if (!existsSync(path)) {
    console.log("No hay identidad guardada. Nada que borrar.");
    return;
  }
  unlinkSync(path);
  console.log(`✓ Identidad borrada (${path}).`);
  console.log("Este agente ya no podrá conectarse hasta que lo vuelvas a emparejar.");
}

async function cmdDoctor(): Promise<void> {
  console.log("Diagnóstico del agente:\n");

  // 1. Chequear nmap
  process.stdout.write("  [1/3] Buscando nmap… ");
  const nmap = await checkNmapInstalled();
  if (nmap.installed) {
    console.log(`✓ encontrado (versión ${nmap.version ?? "?"})`);
  } else {
    console.log("✗ NO encontrado");
    console.log("        Descárgalo desde: https://nmap.org/download");
  }

  // 2. Chequear conectividad al backend
  process.stdout.write("  [2/3] Probando conexión al backend… ");
  const endpoint = process.env["SHS_PAIRING_ENDPOINT"] ?? "https://securitysmartservices.site/api/health";
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(endpoint, { signal: ctrl.signal });
    clearTimeout(timeout);
    console.log(res.ok ? `✓ alcanzable (HTTP ${res.status})` : `✗ HTTP ${res.status}`);
  } catch (err) {
    console.log(`✗ no se pudo contactar: ${err instanceof Error ? err.message : err}`);
  }

  // 3. Chequear identidad
  process.stdout.write("  [3/3] Verificando emparejamiento… ");
  const config = loadConfig();
  console.log(config ? `✓ emparejado (${config.agentId})` : "✗ sin emparejar");

  console.log();
}

function printHelp(): void {
  console.log(`S.S.S Scanner Agent v${VERSION}

Uso:
  shs-scanner <comando> [argumentos]

Comandos:
  pair <código>   Empareja este agente con tu cuenta de S.S.S
  start           Arranca el agente (modo servicio)
  status          Muestra el estado del agente y del sistema
  doctor          Diagnóstico de salud (nmap, red, emparejamiento)
  unpair          Borra la identidad — el agente queda sin emparejar
  version         Muestra la versión
  help            Muestra esta ayuda

Más info: https://github.com/<tu-org>/shs-scanner-agent
`);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "pair":
      await cmdPair(args[0]);
      break;
    case "start":
      await cmdStart();
      break;
    case "status":
      cmdStatus();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "unpair":
      cmdUnpair();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Comando desconocido: ${command}`);
      printHelp();
      process.exit(1);
  }
}

/**
 * Pregunta al servidor local del propio agente quién es. Si nadie contesta
 * o la respuesta no es válida, devolvemos null y seguimos: NO es evidencia
 * de que haya otra instancia (puede no haber nada, o puede haber otro
 * proceso usando el puerto). Solo nos importa el caso positivo: alguien
 * responde con un agentId.
 */
async function probeLocalAgent(): Promise<{ agentId?: string; version?: string } | null> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch("http://127.0.0.1:47878/whoami", { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as { agentId?: string; version?: string };
    return json && typeof json.agentId === "string" ? json : null;
  } catch {
    // ECONNREFUSED / timeout / lo que sea → nadie respondiendo en ese puerto.
    return null;
  }
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
