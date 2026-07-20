// Sync the RUNNING daemon with the repo in one shot.
//
// The daemon agents talk to reads the runtime home (~/.bitrix24-mcp-bridge/), NOT the repo:
// - it serves the bundled dist/cli.js (the global `bitrix24-bridge` bin), and
// - it loads the catalog from ~/.bitrix24-mcp-bridge/actions.json (no BITRIX_CATALOG in a
//   non-dev env), separate from the repo's actions.json.
// So repo changes (new tools in register.ts, new catalog entries) don't reach the daemon
// until the bundle is rebuilt AND the catalog is copied AND the daemon is restarted. This
// does all three. The next agent call respawns a fresh daemon with the current code + catalog.
//
// Run: `bun run sync:runtime`
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runtimePaths } from "../src/paths.js";
import { requestDaemonShutdown } from "../src/bridge/uds-client.js";
import { PROJECT_ROOT } from "../src/config.js";

const paths = runtimePaths(process.env);

// 1) rebuild dist/cli.js — the daemon runs the (symlinked) repo bundle.
execFileSync("node", [join(PROJECT_ROOT, "scripts/build-dist.mjs")], { stdio: "inherit", cwd: PROJECT_ROOT });

// 2) copy the repo catalog into the runtime home the daemon actually reads.
const repoCatalog = join(PROJECT_ROOT, "actions.json");
if (existsSync(repoCatalog)) {
  mkdirSync(paths.home, { recursive: true });
  copyFileSync(repoCatalog, paths.actionsJson);
  console.error(`[sync:runtime] catalog → ${paths.actionsJson}`);
} else {
  console.error(`[sync:runtime] no repo actions.json — skipping catalog copy (run setup or catalog first)`);
}

// 3) stop the daemon; the next agent call respawns it with the fresh bundle + catalog.
const stopped = await requestDaemonShutdown(paths.sock);
console.error(
  stopped
    ? "[sync:runtime] daemon stopped — respawns with fresh code + catalog on the next agent call"
    : "[sync:runtime] no running daemon — next agent call starts fresh anyway",
);
