// Sync the RUNNING daemon and the installed extension with the repo in one shot.
//
// The daemon agents talk to serves the bundled dist/cli.js (the global `bitrix24-bridge` bin),
// NOT the repo sources, and the browser loads the extension materialized into the runtime home.
// So repo changes don't reach either until the bundles are rebuilt, the extension is
// re-materialized and the daemon is restarted. This does all three. The next agent call
// respawns a fresh daemon with the current code; the browser needs the extension reloaded.
//
// Run: `bun run sync:runtime`
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runtimePaths } from "../src/paths.js";
import { stopDaemon } from "../src/bridge/uds-client.js";
import { PROJECT_ROOT } from "../src/config.js";
import { syncMaterializedExtension } from "../src/setup/config-core.js";

const paths = runtimePaths(process.env);

// 1) rebuild dist/cli.js — the daemon runs the (symlinked) repo bundle.
execFileSync("node", [join(PROJECT_ROOT, "scripts/build-dist.mjs")], { stdio: "inherit", cwd: PROJECT_ROOT });

// 2) rebuild the static extension bundles and copy them into the runtime extension.
execFileSync("node", [join(PROJECT_ROOT, "scripts/build-ext-static.mjs")], { stdio: "inherit", cwd: PROJECT_ROOT });
const { version } = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as { version: string };
const extensionDir = syncMaterializedExtension({ home: paths.home, staticExtDir: join(PROJECT_ROOT, "extension/dist"), version });
console.error(
  extensionDir
    ? `[sync:runtime] extension refreshed at ${extensionDir}`
    : `[sync:runtime] no extension set up in ${paths.home} — skipped (run \`bitrix24-bridge setup\` to create it)`,
);

// 3) stop the daemon; the next agent call respawns it with the fresh bundle. Success is the socket
// going away, which also covers a daemon another client was already stopping.
if (!existsSync(paths.sock)) {
  console.error("[sync:runtime] no running daemon — next agent call starts fresh anyway");
} else if (await stopDaemon(paths.sock)) {
  console.error("[sync:runtime] daemon stopped — respawns with fresh code on the next agent call");
} else {
  console.error(`[sync:runtime] daemon did not stop (socket ${paths.sock} is still there) — stop it by hand: pkill -f -- --daemon`);
}
if (extensionDir) {
  console.error("[sync:runtime] reload the extension at chrome://extensions, then reload the portal tab");
}
