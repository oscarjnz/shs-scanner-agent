/**
 * Detecta automáticamente el sistema del cliente.
 *
 * El agente reporta esto al backend cada vez que se conecta, así tu dashboard
 * puede mostrar "Escáner de Juan (Windows 11, ARM64)" sin preguntarle nada.
 */
import { hostname, platform, arch, release, totalmem, cpus, networkInterfaces } from "node:os";
import { execSync } from "node:child_process";

export interface SystemInfo {
  hostname: string;
  /** "windows" | "macos" | "linux" | "unknown" */
  os: string;
  /** "x64" | "arm64" | etc. */
  arch: string;
  /** Versión del SO en formato legible: "Windows 11", "macOS 14.5 (Sonoma)", "Ubuntu 22.04" */
  osVersion: string;
  /** Distribución Linux si aplica: "ubuntu", "debian", "fedora", "arch", o null */
  linuxDistro: string | null;
  cpuCount: number;
  totalMemoryGB: number;
  /** IPs locales del agente (para que el dashboard muestre desde dónde escanea) */
  localIps: string[];
}

function detectOS(): string {
  switch (platform()) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

function detectLinuxDistro(): string | null {
  if (platform() !== "linux") return null;
  try {
    const release = execSync("cat /etc/os-release", { encoding: "utf8", timeout: 1000 });
    const match = release.match(/^ID=(.+)$/m);
    if (match) return match[1].replace(/"/g, "").trim();
  } catch {
    /* fallback below */
  }
  return null;
}

function detectOSVersion(): string {
  const os = detectOS();

  if (os === "windows") {
    try {
      // ej. "Microsoft Windows 11 Pro"
      const out = execSync("wmic os get Caption /value", { encoding: "utf8", timeout: 2000 });
      const match = out.match(/Caption=(.+)/);
      if (match) return match[1].trim();
    } catch {
      /* fallback */
    }
    return `Windows (${release()})`;
  }

  if (os === "macos") {
    try {
      const productVersion = execSync("sw_vers -productVersion", { encoding: "utf8", timeout: 1000 }).trim();
      return `macOS ${productVersion}`;
    } catch {
      return `macOS (${release()})`;
    }
  }

  if (os === "linux") {
    try {
      const out = execSync("cat /etc/os-release", { encoding: "utf8", timeout: 1000 });
      const match = out.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
      if (match) return match[1].trim();
    } catch {
      /* fallback */
    }
    return `Linux ${release()}`;
  }

  return release();
}

function collectLocalIps(): string[] {
  const ifaces = networkInterfaces();
  const ips: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      if (!entry.internal && entry.family === "IPv4") {
        ips.push(entry.address);
      }
    }
  }
  return ips;
}

export function getSystemInfo(): SystemInfo {
  return {
    hostname: hostname(),
    os: detectOS(),
    arch: arch(),
    osVersion: detectOSVersion(),
    linuxDistro: detectLinuxDistro(),
    cpuCount: cpus().length,
    totalMemoryGB: Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    localIps: collectLocalIps(),
  };
}
