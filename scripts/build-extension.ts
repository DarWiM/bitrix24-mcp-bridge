// Builds the browser dev extension. Token / origin / port come from the SAME layered config
// as the daemon (env → .env → ~/.bitrix24-mcp-bridge/config.json, via loadConfig) — the token
// and portal are the shared global settings, so there is no separate dev secret to drift out
// of sync with the daemon. Keep in .env only genuine dev overrides (e.g. BITRIX_ORIGIN).
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
// Deliberately NOT extension/dist: that one belongs to the publish-safe build
// (`build:ext:static`), which wipes its output directory and runs from `prepare` — i.e. on every
// `bun install`. Sharing a directory meant an unrelated dependency install silently deleted the
// manifest of the extension loaded in the browser. The dev build owns this directory alone.
const DIST = "extension/dev";

// Shared, layered resolution — identical to the daemon's, so the dev extension's token always
// matches the daemon's. loadConfig already strips the origin's trailing slash.
const cfg = loadConfig(process.env);
const { token, port } = cfg;
const origin = cfg.bitrixOrigin;
// Extension version tracks the package version (bumped by release-please) — single source.
const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;

mkdirSync(DIST, { recursive: true });

// 1) bundle the two STATIC content scripts (no token/port baked in).
await build({
  entryPoints: [`${SRC}/connector.ts`, `${SRC}/sessid-shim.ts`],
  bundle: true,
  format: "iife",
  outdir: DIST,
  sourcemap: true, // emits *.js.map + //# sourceMappingURL for DevTools
});

// 2) emit the per-user config.json the connector fetches at runtime (token lives ONLY here).
writeFileSync(`${DIST}/config.json`, JSON.stringify({ token, port }, null, 2) + "\n");

// 3) generate manifest.json from the template with the portal origin.
const template = readFileSync(`${SRC}/manifest.template.json`, "utf8");
const manifest = template
  .replaceAll("__ORIGIN__", origin)
  .replaceAll("__VERSION__", version);
writeFileSync(`${DIST}/manifest.json`, manifest);

console.error(`[build:ext] built ${DIST} for ${origin} → ws://127.0.0.1:${port}`);
console.error(`[build:ext] load it via chrome://extensions → «Load unpacked» → ${DIST}`);
