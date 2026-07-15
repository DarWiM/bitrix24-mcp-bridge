import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

export interface Config {
  port: number;
  token: string;
  bitrixOrigin: string;
  catalogPath: string;
}

// Repo root, derived from THIS module's location (src/config.ts → ..), so it is
// independent of process.cwd(). Claude Code spawns this stdio server from an
// arbitrary working directory; a cwd-relative catalog path would ENOENT at
// startup and surface as "Failed to connect". Mirrors tools/help.ts.
const PROJECT_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.BITRIX_MCP_TOKEN?.trim();
  if (!token) throw new Error("BITRIX_MCP_TOKEN (shared token) is required");
  const bitrixOriginRaw = env.BITRIX_ORIGIN?.trim();
  if (!bitrixOriginRaw) throw new Error("BITRIX_ORIGIN (e.g. https://portal.bitrix24.ru) is required");
  // Strip trailing slash(es): a browser Origin header never carries one, so the
  // WS Origin check must compare against the bare origin.
  const bitrixOrigin = bitrixOriginRaw.replace(/\/+$/, "");
  // Relative catalog paths are anchored at the project root, not the cwd.
  const rawCatalog = env.BITRIX_CATALOG?.trim() || "actions.json";
  const catalogPath = isAbsolute(rawCatalog) ? rawCatalog : resolve(PROJECT_ROOT, rawCatalog);
  return {
    token,
    bitrixOrigin,
    port: Number(env.BITRIX_MCP_PORT ?? 39917),
    catalogPath,
  };
}
