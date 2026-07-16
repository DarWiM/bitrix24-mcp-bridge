import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runtimePaths } from "./paths.js";

export interface PortalConfig {
  origin: string;
  catalog?: string;
}

export interface Config {
  port: number;
  token: string;
  portals: Record<string, PortalConfig>;
  defaultPortal: string;
  bitrixOrigin: string;
  catalogPath: string;
  allowedOrigins: string[];
}

// src/config.ts → ".." is the repo root; independent of process.cwd().
export const PROJECT_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const stripSlash = (o: string) => o.replace(/\/+$/, "");

interface FileConfig {
  token?: string;
  port?: number;
  defaultPortal?: string;
  portals?: Record<string, PortalConfig>;
  catalog?: string;
}

function readFileConfig(env: NodeJS.ProcessEnv): FileConfig {
  const path = runtimePaths(env).configJson;
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch (e) {
    throw new Error(`invalid config at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const file = readFileConfig(env);

  const token = env.BITRIX_MCP_TOKEN?.trim() || file.token;
  if (!token) throw new Error("BITRIX_MCP_TOKEN (shared token) is required — run setup or set the env var");

  // Portals: config.json map is the base; a dev BITRIX_ORIGIN defines a single "default" portal.
  const portals: Record<string, PortalConfig> = {};
  for (const [alias, p] of Object.entries(file.portals ?? {})) {
    if (typeof p.origin !== "string" || !p.origin) {
      throw new Error(`config.json portal "${alias}" is missing a string origin`);
    }
    portals[alias] = { ...p, origin: stripSlash(p.origin) };
  }
  const envOrigin = env.BITRIX_ORIGIN?.trim();
  if (envOrigin) portals.default = { origin: stripSlash(envOrigin) };

  const aliases = Object.keys(portals);
  if (aliases.length === 0) {
    throw new Error("no portal origin configured — set BITRIX_ORIGIN or add a portal in config.json");
  }
  const defaultPortal =
    (file.defaultPortal && portals[file.defaultPortal] ? file.defaultPortal : undefined) ??
    (portals.default ? "default" : aliases[0]);

  const rawCatalog = env.BITRIX_CATALOG?.trim() || file.catalog || "actions.json";
  const catalogPath = isAbsolute(rawCatalog) ? rawCatalog : resolve(PROJECT_ROOT, rawCatalog);

  return {
    token,
    port: Number(env.BITRIX_MCP_PORT ?? file.port ?? 39917),
    portals,
    defaultPortal,
    bitrixOrigin: portals[defaultPortal].origin,
    catalogPath,
    allowedOrigins: Object.values(portals).map((p) => p.origin),
  };
}

export type ConfigState =
  | { status: "configured"; config: Config }
  | { status: "unconfigured"; reason: string };

// Non-throwing wrapper for callers that must keep running when config is absent
// (the stdio MCP client): unconfigured is a normal, guidable state, not an error.
export function loadConfigState(env: NodeJS.ProcessEnv): ConfigState {
  try {
    return { status: "configured", config: loadConfig(env) };
  } catch (e) {
    return { status: "unconfigured", reason: e instanceof Error ? e.message : String(e) };
  }
}
