import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { runtimePaths } from "./paths.js";
import { Daemon } from "./bridge/daemon.js";
import { UdsClient } from "./bridge/uds-client.js";
import { loadCatalog } from "./catalog/catalog.js";
import { registerTools } from "./tools/register.js";

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
  const cfg = loadConfig(process.env);
  const sockPath = runtimePaths(process.env).sock;

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

  const catalog = loadCatalog(cfg.catalogPath);
  const server = new McpServer({ name: "bitrix24-bridge", version: "0.1.0" });
  registerTools(server, { sink: client, catalog, defaultPortal: cfg.defaultPortal, portals: Object.keys(cfg.portals) });
  await server.connect(new StdioServerTransport());
  console.error("[mcp] bitrix24-bridge client running on stdio");

  const shutdown = () => { client.close(); process.exit(0); };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const main = process.argv.includes("--daemon") ? runDaemon : runMcpClient;
main().catch((e) => { console.error(e); process.exit(1); });
