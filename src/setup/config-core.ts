import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
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

// --- extension materialization ---

export interface ExtensionManifest {
  manifest_version: 3;
  name: string;
  version: string;
  description: string;
  host_permissions: string[];
  content_scripts: Array<{
    matches: string[];
    js: string[];
    world: "ISOLATED" | "MAIN";
    run_at: "document_idle";
  }>;
  web_accessible_resources: Array<{
    resources: string[];
    matches: string[];
    use_dynamic_url: true;
  }>;
}

export function buildManifest(config: ServerConfig): ExtensionManifest {
  const matches = Object.values(config.portals).map((p) => `${p.origin}/*`);
  return {
    manifest_version: 3,
    name: "Bitrix24 MCP Bridge",
    version: "0.1.0",
    description: "Отдаёт данные текущей сессии Bitrix24 локальному MCP-серверу (read-only).",
    host_permissions: matches,
    content_scripts: [
      { matches, js: ["connector.js"], world: "ISOLATED", run_at: "document_idle" },
      { matches, js: ["sessid-shim.js"], world: "MAIN", run_at: "document_idle" },
    ],
    web_accessible_resources: [
      { resources: ["config.json"], matches, use_dynamic_url: true },
    ],
  };
}

const STATIC_BUNDLES = ["connector.js", "sessid-shim.js"];
const BUNDLE_MAPS = ["connector.js.map", "sessid-shim.js.map"];

export function materializeExtension(args: { home: string; config: ServerConfig; staticExtDir: string }): string {
  const destDir = join(args.home, "extension");
  mkdirSync(destDir, { recursive: true });
  for (const name of STATIC_BUNDLES) {
    const src = join(args.staticExtDir, name);
    if (!existsSync(src)) {
      throw new Error(`static extension bundle missing: ${src} (run \`npm run build:ext:static\`)`);
    }
    copyFileSync(src, join(destDir, name));
  }
  for (const name of BUNDLE_MAPS) {
    const src = join(args.staticExtDir, name);
    if (existsSync(src)) copyFileSync(src, join(destDir, name));
  }
  writeFileSync(
    join(destDir, "config.json"),
    JSON.stringify({ token: args.config.token, port: args.config.port }, null, 2) + "\n",
  );
  writeFileSync(
    join(destDir, "manifest.json"),
    JSON.stringify(buildManifest(args.config), null, 2) + "\n",
  );
  return destDir;
}
