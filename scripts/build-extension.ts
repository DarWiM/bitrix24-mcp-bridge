// Builds the browser dev extension. Token / origin / port come from the SAME layered config
// as the daemon (env → .env → ~/.bitrix24-mcp-bridge/config.json, via loadConfig) — the token
// and portal are the shared global settings, so there is no separate dev secret to drift out
// of sync with the daemon. Keep in .env only genuine dev overrides (e.g. BITRIX_CATALOG).
//
// The content-script JS is STATIC and config-driven: no per-user value is baked into it.
// We emit a per-user dist/config.json ({ token, port }) the ISOLATED-world connector fetches at
// runtime; the portal origin is templated into the manifest.
//
// Run via `bun run build:ext` — Bun auto-loads `.env` from the project root.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.js";

const SRC = "extension/src";
const DIST = "extension/dist";

const capture = !!process.env.BITRIX_CAPTURE; // capture (recording) build
// Shared, layered resolution — identical to the daemon's, so the dev extension's token always
// matches the daemon's. loadConfig already strips the origin's trailing slash.
const cfg = loadConfig(process.env);
const { token, port } = cfg;
const origin = cfg.bitrixOrigin;
// Extension version tracks the package version (bumped by release-please) — single source.
const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;

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
  .replaceAll("__NAME_SUFFIX__", capture ? " [CAPTURE]" : "")
  .replaceAll("__VERSION__", version);
writeFileSync(`${DIST}/manifest.json`, manifest);

console.error(`[build:ext] built extension/dist for ${origin} → ws://127.0.0.1:${port}${capture ? " [CAPTURE mode]" : ""}`);
