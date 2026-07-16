// Plain-node ESM build script (runs during `npm install`/`prepare`, where Bun may be absent).
// Bundles the server for Node, inlines docs/api-notes.md as __API_NOTES__, and prepends a shebang.
import { build } from "esbuild";
import { readFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiNotes = readFileSync(join(ROOT, "docs/api-notes.md"), "utf8");
const outfile = join(ROOT, "dist/cli.js");

await build({
  entryPoints: [join(ROOT, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __API_NOTES__: JSON.stringify(apiNotes),
    __BITRIX_CAPTURE__: "false",
  },
  logLevel: "info",
});

chmodSync(outfile, 0o755);
console.error(`[build:dist] wrote ${outfile}`);
