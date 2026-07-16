// Plain-node ESM build (prepare-safe; Bun may be absent on `npm i -g`).
// Emits the STATIC, config-driven content-script bundles only — no per-user token/port
// and no manifest. Setup materializes config.json + manifest.json per-user at runtime.
import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "extension/src");
const DIST = join(ROOT, "extension/dist");

// Drop the whole dist first so stale artifacts (e.g. a bridge-client.js from an older build) never ship.
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [join(SRC, "connector.ts"), join(SRC, "sessid-shim.ts")],
  bundle: true,
  format: "iife",
  outdir: DIST,
  sourcemap: true, // emits *.js.map + //# sourceMappingURL for DevTools
  minifySyntax: true, // drop dead branches (e.g. capture recorder in normal builds)
  define: {
    __BITRIX_CAPTURE__: "false",
  },
  logLevel: "info",
});

console.error(`[build:ext:static] wrote ${DIST}/{connector,sessid-shim}.js (+ maps)`);
