// Sync the RUNNING daemon with the repo in one shot.
//
// The daemon agents talk to serves the bundled dist/cli.js (the global `bitrix24-bridge` bin),
// NOT the repo sources. So repo changes (new tools or operations) don't reach it until the
// bundle is rebuilt AND the daemon is restarted. This does both. The next agent call
// respawns a fresh daemon with the current code.
//
// Run: `bun run sync:runtime`
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runtimePaths } from "../src/paths.js";
import { requestDaemonShutdown } from "../src/bridge/uds-client.js";
import { PROJECT_ROOT } from "../src/config.js";

const paths = runtimePaths(process.env);

// 1) rebuild dist/cli.js — the daemon runs the (symlinked) repo bundle.
execFileSync("node", [join(PROJECT_ROOT, "scripts/build-dist.mjs")], { stdio: "inherit", cwd: PROJECT_ROOT });

// 2) stop the daemon; the next agent call respawns it with the fresh bundle.
const stopped = await requestDaemonShutdown(paths.sock);
console.error(
  stopped
    ? "[sync:runtime] daemon stopped — respawns with fresh code on the next agent call"
    : "[sync:runtime] no running daemon — next agent call starts fresh anyway",
);
