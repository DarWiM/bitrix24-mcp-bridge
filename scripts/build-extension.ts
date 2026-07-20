// Builds the browser extension from env config (single source of truth: .env).
//
// The content-script JS is STATIC and config-driven: no per-user value is baked into it.
// Instead we emit a per-user dist/config.json ({ token, port }) that the ISOLATED-world
// connector fetches at runtime via chrome.runtime.getURL. Only BITRIX_ORIGIN is templated
// into the manifest (matches / host_permissions / web_accessible_resources).
//
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
const capture = !!process.env.BITRIX_CAPTURE; // capture (recording) build

mkdirSync(DIST, { recursive: true });

// 1) bundle the two STATIC content scripts (no token/port baked in).
//    __BITRIX_CAPTURE__ is the only define — it lets esbuild dead-code-strip the recorder
//    from normal builds.
await build({
  entryPoints: [`${SRC}/connector.ts`, `${SRC}/sessid-shim.ts`],
  bundle: true,
  format: "iife",
  outdir: DIST,
  sourcemap: true, // emits *.js.map + //# sourceMappingURL for DevTools
  minifySyntax: true, // drop dead branches (e.g. `if (false) installCapture(...)` in normal builds)
  define: {
    __BITRIX_CAPTURE__: String(capture),
  },
});

// 2) emit the per-user config.json the connector fetches at runtime (token lives ONLY here).
writeFileSync(`${DIST}/config.json`, JSON.stringify({ token, port }, null, 2) + "\n");

// 3) generate manifest.json from the template with the portal origin.
//    Capture builds get a " [CAPTURE]" name suffix so a recording extension is impossible
//    to confuse with the normal one in chrome://extensions.
const template = readFileSync(`${SRC}/manifest.template.json`, "utf8");
const manifest = template
  .replaceAll("__ORIGIN__", origin)
  .replaceAll("__NAME_SUFFIX__", capture ? " [CAPTURE]" : "");
writeFileSync(`${DIST}/manifest.json`, manifest);

console.error(`[build:ext] built extension/dist for ${origin} → ws://127.0.0.1:${port}${capture ? " [CAPTURE mode]" : ""}`);
