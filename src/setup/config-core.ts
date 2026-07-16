import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PortalConfig } from "../config.js";

export const DEFAULT_PORT = 39917;

export interface ServerConfig {
  token: string;
  port: number;
  defaultPortal: string;
  portals: Record<string, PortalConfig>;
  catalog?: string;
}

const stripSlash = (o: string): string => o.replace(/\/+$/, "");

function validateAlias(alias: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(alias)) {
    throw new Error(`invalid portal alias "${alias}" (use letters, digits, "-" or "_")`);
  }
  return alias;
}

function validateOrigin(origin: string): string {
  if (!/^https?:\/\/.+/.test(origin)) {
    throw new Error(`invalid portal origin "${origin}" (must be an http(s):// URL)`);
  }
  return stripSlash(origin);
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function serverConfigPath(home: string): string {
  return join(home, "config.json");
}

export function readServerConfig(home: string): ServerConfig | null {
  const path = serverConfigPath(home);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ServerConfig;
}

export function writeServerConfig(home: string, config: ServerConfig): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(serverConfigPath(home), JSON.stringify(config, null, 2) + "\n");
}

export function createInitialConfig(args: { origin: string; alias: string; port?: number }): ServerConfig {
  const alias = validateAlias(args.alias);
  const origin = validateOrigin(args.origin);
  return {
    token: newToken(),
    port: args.port ?? DEFAULT_PORT,
    defaultPortal: alias,
    portals: { [alias]: { origin } },
  };
}

export function addPortal(config: ServerConfig, args: { alias: string; origin: string; catalog?: string }): ServerConfig {
  const alias = validateAlias(args.alias);
  if (config.portals[alias]) throw new Error(`portal "${alias}" already exists`);
  const portal: PortalConfig = { origin: validateOrigin(args.origin) };
  if (args.catalog) portal.catalog = args.catalog;
  return { ...config, portals: { ...config.portals, [alias]: portal } };
}

export function removePortal(config: ServerConfig, alias: string): ServerConfig {
  if (!config.portals[alias]) throw new Error(`portal "${alias}" does not exist`);
  const remaining = Object.keys(config.portals).filter((a) => a !== alias);
  if (remaining.length === 0) throw new Error(`cannot remove the only portal "${alias}"`);
  const portals: Record<string, PortalConfig> = {};
  for (const a of remaining) portals[a] = config.portals[a];
  const defaultPortal = config.defaultPortal === alias ? remaining[0] : config.defaultPortal;
  return { ...config, portals, defaultPortal };
}

export function setPort(config: ServerConfig, port: number): ServerConfig {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${port} (expected 1..65535)`);
  }
  return { ...config, port };
}

export function rotateToken(config: ServerConfig): ServerConfig {
  return { ...config, token: newToken() };
}

export function setDefaultPortal(config: ServerConfig, alias: string): ServerConfig {
  if (!config.portals[alias]) throw new Error(`portal "${alias}" does not exist`);
  return { ...config, defaultPortal: alias };
}
