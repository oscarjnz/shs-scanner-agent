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
 * Lista blanca de flags de nmap permitidos. Si llega cualquier otra cosa,
 * rechazamos el escaneo. Esto es la última línea de defensa por si el backend
 * fuera comprometido o tuviera un bug.
 */
const ALLOWED_NMAP_FLAGS = new Set([
  "-sn", "-sS", "-sT", "-sU", "-sV", "-sC", "-O", "-A",
  "-Pn", "-n", "-T0", "-T1", "-T2", "-T3", "-T4", "-T5",
  "-p", "--top-ports", "--open", "--reason",
  "-oX", "-oN", "-oG", "--stylesheet",
  "--max-retries", "--host-timeout", "--scan-delay",
  "--script", "--script-args",
  "-v", "-vv", "-d",
]);

function isFlagAllowed(flag: string): boolean {
  if (!flag.startsWith("-")) return true; // valores posicionales (target, números de puerto)
  // Acepta flags exactos o que empiecen con uno permitido seguido de =
  if (ALLOWED_NMAP_FLAGS.has(flag)) return true;
  const eqIdx = flag.indexOf("=");
  if (eqIdx > 0 && ALLOWED_NMAP_FLAGS.has(flag.slice(0, eqIdx))) return true;
  return false;
}

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

  // Validar cada flag contra la lista blanca
  for (const arg of nmapArgs) {
    if (!isFlagAllowed(arg)) {
      throw new Error(`Argumento de nmap no permitido: "${arg}"`);
    }
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

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      // Si nmap saca una línea de progreso, la reenviamos para que el dashboard la muestre en vivo
      const lastLine = text.trim().split("\n").pop();
      if (lastLine && lastLine.length > 0 && lastLine.length < 200) {
        onProgress(lastLine);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const onAbort = () => {
      onProgress("Cancelado por el usuario");
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 2000);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err) => {
      abortSignal.removeEventListener("abort", onAbort);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("nmap no está instalado en esta máquina. Instálalo desde https://nmap.org/download"));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      abortSignal.removeEventListener("abort", onAbort);
      if (abortSignal.aborted) {
        reject(new Error("Escaneo cancelado"));
        return;
      }
      resolve({
        rawOutput: stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ""),
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
