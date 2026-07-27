import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadConfigState, PROJECT_ROOT } from "./config.js";
import { runtimePaths } from "./paths.js";
import { Daemon } from "./bridge/daemon.js";
import { UdsClient } from "./bridge/uds-client.js";
import { loadCatalog } from "./catalog/catalog.js";
import { syncCatalogWithPackage } from "./catalog/sync.js";
import { join } from "node:path";
import { registerTools } from "./tools/register.js";
import { registerUnconfiguredTools } from "./tools/unconfigured.js";
import { runSetup } from "./setup/setup.js";
import { refreshMaterializedExtension } from "./setup/config-core.js";

async function runDaemon() {
  const cfg = loadConfig(process.env);
  const sockPath = runtimePaths(process.env).sock;
  const daemon = new Daemon({ port: cfg.port, token: cfg.token, portals: cfg.portals, sockPath });
  await daemon.start();
  const shutdown = () => daemon.stop().finally(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function runMcpClient() {
  const state = loadConfigState(process.env);
  const server = new McpServer({ name: "bitrix24-bridge", version: "0.1.0" });

  if (state.status === "unconfigured") {
    registerUnconfiguredTools(server, state.reason);
    await server.connect(new StdioServerTransport());
    console.error(`[mcp] bitrix24-bridge unconfigured — run \`bitrix24-bridge setup\` (${state.reason})`);
    const shutdown = () => process.exit(0);
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    return;
  }

  const cfg = state.config;
  const paths = runtimePaths(process.env);
  const sockPath = paths.sock;

  const client = new UdsClient({
    sockPath,
    spawnDaemon: () => {
      const child = spawn(process.execPath, [process.argv[1], "--daemon"], {
        detached: true, stdio: "ignore", env: process.env,
      });
      child.unref();
    },
  });
  await client.connect();

  // A package upgrade ships new catalog entries, but the installed catalog is the user's file
  // (and the allowlist), so it is never overwritten — only extended with entries this install
  // has not been offered before.
  const added = syncCatalogWithPackage({
    catalogPath: cfg.catalogPath,
    examplePath: join(PROJECT_ROOT, "actions.example.json"),
    statePath: paths.catalogStateJson,
  });
  if (added.length > 0) console.error(`[catalog] added ${added.length} new entries from the package: ${added.join(", ")}`);

  // Same idea for the extension bundles: refresh what setup materialized, so an upgrade doesn't
  // depend on the user remembering `setup` → [u]. They still have to hit "Обновить" in Chrome —
  // and bitrix_status says so, because the extension reports its own version on connect.
  try {
    const refreshed = refreshMaterializedExtension({
      home: paths.home,
      config: { token: cfg.token, port: cfg.port, defaultPortal: cfg.defaultPortal, portals: cfg.portals },
      staticExtDir: join(PROJECT_ROOT, "extension/dist"),
    });
    if (refreshed) {
      console.error(`[extension] refreshed ${paths.extensionDir} to ${refreshed} — reload it at chrome://extensions`);
    }
  } catch (e) {
    console.error(`[extension] could not refresh: ${e instanceof Error ? e.message : String(e)}`);
  }

  const catalog = loadCatalog(cfg.catalogPath);
  registerTools(server, {
    sink: client,
    catalog,
    defaultPortal: cfg.defaultPortal,
    portals: Object.keys(cfg.portals),
    origins: Object.fromEntries(Object.entries(cfg.portals).map(([alias, p]) => [alias, p.origin])),
    downloadsDir: runtimePaths(process.env).downloadsDir,
  });
  await server.connect(new StdioServerTransport());
  console.error("[mcp] bitrix24-bridge client running on stdio");

  const shutdown = () => { client.close(); process.exit(0); };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const main = process.argv.includes("setup")
  ? () => runSetup(process.env)
  : process.argv.includes("--daemon")
    ? runDaemon
    : runMcpClient;
main().catch((e) => { console.error(e); process.exit(1); });
