/**
 * El ejecutor de nmap.
 *
 * Solo hace una cosa: corre el comando nmap con los argumentos que le pase el backend
 * y devuelve la salida cruda. La interpretación de esa salida (qué dispositivos,
 * qué puertos, qué amenazas) la sigue haciendo el backend, no este agente.
 *
 * SEGURIDAD: el agente NUNCA ejecuta argumentos arbitrarios que vengan del cliente.
 * El backend ya filtró y validó esos argumentos contra una lista blanca antes de mandarlos.
 * Aún así aquí volvemos a chequear que no se cuelen cosas raras.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Readable } from "node:stream";

/**
 * Validacion de argumentos de nmap: ultima linea de defensa en la maquina del
 * usuario, por si el backend/relay estuviera comprometido. El backend ya valido
 * los flags (agent/src/lib/scanner.ts) antes de mandarlos; aqui aplicamos el
 * MISMO criterio para ser consistentes:
 *   - formato de flag valido,
 *   - lista NEGRA de flags peligrosos (salida a archivo, targets desde archivo,
 *     targets aleatorios -> internet, spoofing, decoys, forzar interfaz),
 *   - --script restringido a categorias seguras.
 *
 * Antes esto era una lista BLANCA de flags EXACTOS. Eso rechazaba flags legitimos
 * de los perfiles (ej. -PE/-PP/-PM/-PS/-PA/-PU del descubrimiento, -F, -p-) y le
 * tiraba al usuario un "Argumento de nmap no permitido" en rojo. El enfoque por
 * lista negra no se rompe con cada flag nuevo y ademas es MAS estricto con lo
 * peligroso (la lista blanca vieja dejaba pasar -oX y --script con cualquier valor).
 */
const FLAG_FORMAT = /^-{1,2}[A-Za-z][A-Za-z0-9_-]*([0-9,.:/+-]*)?(=.+)?$/;
const VALUE_FORMAT = /^[A-Za-z0-9_,.:/+-]+$/;

// OJO: nmap distingue mayus/minus y varios flags peligrosos colisionan con
// flags legitimos si se ignora el case (-O deteccion de SO vs -oN salida a
// archivo; -D decoys vs -d debug). Por eso la lista negra es case-SENSITIVE.
const FLAG_BLACKLIST: RegExp[] = [
  /^-o[NXSGAJ]$/,           // salida a archivo (-oN/-oX/-oS/-oG/-oA/-oJ). NO bloquea -O (deteccion de SO)
  /^--output/,
  /^-iL$/,                  // targets desde archivo
  /^-iR$/,                  // targets aleatorios: podria escanear internet (nunca)
  /^--datadir/,
  /^--resume/,
  /^--send-eth$/,
  /^--script-args-file/,
  /^--script-help/,
  /^--privileged$/,
  /^--unprivileged$/,
  /^-D$/,                   // decoys (spoofing). NO bloquea -d (debug)
  /^-S$/,                   // spoof source address
  /^-e$/,                   // forzar interfaz de red
];

const ALLOWED_SCRIPT_CATEGORIES = new Set(["safe", "discovery", "default", "version", "auth-safe"]);
const SCRIPT_BLOCK_KEYWORDS = ["vuln", "exploit", "brute", "dos", "malware", "intrusive", "external", "fuzzer"];

/** Valida un --script=cat1,cat2 : solo categorias seguras (igual que el backend). */
function validateScriptArg(arg: string): string | null {
  const eq = arg.indexOf("=");
  if (eq === -1) return null; // "--script" sin valor: nmap fallara solo, no es peligroso
  const parts = arg.slice(eq + 1).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const part of parts) {
    if (SCRIPT_BLOCK_KEYWORDS.some((bad) => part.includes(bad))) {
      return `Script NSE bloqueado por seguridad: "${part}".`;
    }
    if (!ALLOWED_SCRIPT_CATEGORIES.has(part)) {
      return `Script NSE no permitido: "${part}". Solo: ${[...ALLOWED_SCRIPT_CATEGORIES].join(", ")}.`;
    }
  }
  return null;
}

/** Devuelve null si el argumento es aceptable, o el motivo del rechazo. */
function checkArg(arg: string): string | null {
  if (!arg.startsWith("-")) {
    // Valor posicional (numeros de puerto, listas). El target se valida aparte.
    return VALUE_FORMAT.test(arg) ? null : `Valor con caracteres no permitidos: "${arg}"`;
  }
  if (!FLAG_FORMAT.test(arg)) return `Flag con formato invalido: "${arg}"`;
  const flagOnly = arg.split("=")[0]!;
  if (FLAG_BLACKLIST.some((re) => re.test(flagOnly))) {
    return `Flag de nmap bloqueado por seguridad: "${flagOnly}"`;
  }
  if (arg.startsWith("--script")) return validateScriptArg(arg);
  return null;
}

/**
 * Límite duro de salida acumulada (stdout+stderr) por escaneo. Sin esto un
 * `nmap -p- -v` muy verboso podría acumular cientos de MB en memoria en la
 * máquina del usuario y, al enviarse como un solo frame WS, tumbar el relay.
 * El relay solo guarda ~200KB, así que 1MB aquí es holgado y nunca pierde nada
 * útil. Configurable por si acaso.
 */
const MAX_OUTPUT_BYTES = Number(process.env["SHS_SCAN_MAX_OUTPUT_BYTES"] ?? 1024 * 1024);

/**
 * Timeout local de seguridad por escaneo. La cancelación normal llega por el
 * mensaje `cancel` del relay, pero si esa señal nunca llega (relay caído, red
 * partida) un escaneo no debe correr indefinidamente en la máquina del usuario.
 * Generoso a propósito (20 min) para no matar escaneos legítimos largos como
 * un TCP completo; el timeout del job en el relay es de 30 min.
 */
const MAX_SCAN_MS = Number(process.env["SHS_SCAN_TIMEOUT_MS"] ?? 20 * 60_000);

export interface ScanResult {
  rawOutput: string;
  durationMs: number;
  exitCode: number;
}

export interface ScanProgressCallback {
  (message: string): void;
}

/**
 * Lanza nmap y devuelve la salida cuando termina.
 * El abortSignal permite cancelar el escaneo desde fuera (cliente cerró el dashboard, etc.)
 */
export async function runScan(
  target: string,
  nmapArgs: string[],
  onProgress: ScanProgressCallback,
  abortSignal: AbortSignal,
): Promise<ScanResult> {
  // Validar target: solo IPs, rangos CIDR, hostnames simples. Nada de pipes, ; & etc.
  if (!/^[a-zA-Z0-9.\-_/:]+$/.test(target)) {
    throw new Error(`Target inválido: "${target}" contiene caracteres no permitidos`);
  }

  // Validar cada argumento (formato + lista negra + scripts seguros)
  for (const arg of nmapArgs) {
    const err = checkArg(arg);
    if (err) throw new Error(err);
  }

  const startedAt = Date.now();
  const fullArgs = [...nmapArgs, target];
  onProgress(`Ejecutando: nmap ${fullArgs.join(" ")}`);

  return new Promise((resolve, reject) => {
    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn("nmap", fullArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        // En Windows, evita abrir una ventana de consola visible
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`No se pudo lanzar nmap. ¿Está instalado? Detalle: ${err instanceof Error ? err.message : err}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;

    // Corta el proceso si la salida supera el límite: evita OOM en la máquina
    // del usuario y frames gigantes hacia el relay.
    const enforceCap = (addedBytes: number) => {
      totalBytes += addedBytes;
      if (totalBytes > MAX_OUTPUT_BYTES && !truncated) {
        truncated = true;
        onProgress("[salida truncada: límite de salida alcanzado]");
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 2000);
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const text = chunk.toString();
      stdout += text;
      enforceCap(chunk.byteLength);
      // Si nmap saca una línea de progreso, la reenviamos para que el dashboard la muestre en vivo
      const lastLine = text.trim().split("\n").pop();
      if (lastLine && lastLine.length > 0 && lastLine.length < 200) {
        onProgress(lastLine);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      if (truncated) return;
      stderr += chunk.toString();
      enforceCap(chunk.byteLength);
    });

    const cleanup = () => {
      clearTimeout(hardTimeout);
      abortSignal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      onProgress("Cancelado por el usuario");
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 2000);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });

    // Timeout local de seguridad: si el escaneo se pasa de MAX_SCAN_MS, lo matamos.
    const hardTimeout = setTimeout(() => {
      timedOut = true;
      onProgress(`[timeout: el escaneo excedió ${Math.round(MAX_SCAN_MS / 1000)}s]`);
      proc.kill("SIGTERM");
      setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 2000);
    }, MAX_SCAN_MS);

    proc.on("error", (err) => {
      cleanup();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("nmap no está instalado en esta máquina. Instálalo desde https://nmap.org/download"));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      cleanup();
      if (abortSignal.aborted) {
        reject(new Error("Escaneo cancelado"));
        return;
      }
      if (timedOut) {
        reject(new Error(`Escaneo cancelado por timeout (${Math.round(MAX_SCAN_MS / 1000)}s)`));
        return;
      }
      resolve({
        rawOutput: stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "") + (truncated ? "\n--- salida truncada ---" : ""),
        durationMs: Date.now() - startedAt,
        exitCode: code ?? -1,
      });
    });
  });
}

/**
 * Chequea si nmap está instalado en el sistema. Útil para mostrarle al cliente
 * un mensaje claro al instalar el agente: "OK nmap detectado" / "Falta instalar nmap".
 */
export async function checkNmapInstalled(): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("nmap", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      // shell:true es necesario en Windows para resolver "nmap" en el PATH
      shell: process.platform === "win32",
    });

    let output = "";
    let settled = false;
    const finish = (result: { installed: boolean; version?: string }) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* noop */ }
      resolve(result);
    };

    // Timeout de seguridad: si en 5s no respondió, asumimos que no está
    const timeout = setTimeout(() => finish({ installed: false }), 5000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on("error", () => {
      clearTimeout(timeout);
      finish({ installed: false });
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        const match = output.match(/Nmap version (\S+)/);
        finish({ installed: true, version: match?.[1] });
      } else {
        finish({ installed: false });
      }
    });
  });
}
