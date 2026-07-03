/**
 * Version del scanner-agent en UN solo lugar.
 *
 * Antes vivia duplicada en index.ts ("0.1.4") y en relay-client.ts ("0.1.0"),
 * y la del relay-client se quedo vieja: el agente le reportaba al relay una
 * version incorrecta. Mantener este archivo como fuente unica evita esa deriva.
 * Debe coincidir con el "version" de package.json al hacer release.
 */
export const VERSION = "0.1.4";
