// Builds the browser extension from env config (single source of truth: .env).
//
// Reads BITRIX_MCP_TOKEN, BITRIX_ORIGIN, BITRIX_MCP_PORT, injects the token/port
// into the content script (esbuild `define`) and the origin into the manifest.
// Run via `bun run build:ext` — Bun auto-loads `.env` from the project root.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[build:ext] missing env ${name} — set it in .env (see .env.example)`);
    process.exit(1);
  }
  return v;
}

const token = required("BITRIX_MCP_TOKEN");
// A browser Origin header carries no trailing slash; normalize to match the server's check.
const origin = required("BITRIX_ORIGIN").replace(/\/+$/, "");
const port = Number(process.env.BITRIX_MCP_PORT ?? 39917);

// 1) bundle the MAIN-world content script with token/port injected as literals
await build({
  entryPoints: ["extension/bridge-client.src.ts"],
  bundle: true,
  format: "iife",
  outfile: "extension/bridge-client.js",
  define: {
    __BITRIX_TOKEN__: JSON.stringify(token),
    __BITRIX_PORT__: String(port),
  },
});

// 2) generate manifest.json from the template with the portal origin
const template = readFileSync("extension/manifest.template.json", "utf8");
writeFileSync("extension/manifest.json", template.replaceAll("__ORIGIN__", origin));

console.error(`[build:ext] built extension for ${origin} → ws://127.0.0.1:${port}`);
