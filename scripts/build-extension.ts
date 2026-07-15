// Builds the browser extension from env config (single source of truth: .env).
//
// Reads BITRIX_MCP_TOKEN, BITRIX_ORIGIN, BITRIX_MCP_PORT, injects the token/port
// into the content script (esbuild `define`) and the origin into the manifest.
// Run via `bun run build:ext` — Bun auto-loads `.env` from the project root.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SRC = "extension/src";
const DIST = "extension/dist";

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

mkdirSync(DIST, { recursive: true });

// 1) bundle the MAIN-world content script with token/port injected as literals
await build({
  entryPoints: [`${SRC}/bridge-client.ts`],
  bundle: true,
  format: "iife",
  outfile: `${DIST}/bridge-client.js`,
  sourcemap: true, // emits dist/bridge-client.js.map + //# sourceMappingURL for DevTools
  define: {
    __BITRIX_TOKEN__: JSON.stringify(token),
    __BITRIX_PORT__: String(port),
  },
});

// 2) generate manifest.json from the template with the portal origin
const template = readFileSync(`${SRC}/manifest.template.json`, "utf8");
writeFileSync(`${DIST}/manifest.json`, template.replaceAll("__ORIGIN__", origin));

console.error(`[build:ext] built extension/dist for ${origin} → ws://127.0.0.1:${port}`);
