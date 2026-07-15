import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge/server.js";
import { loadCatalog } from "./catalog/catalog.js";
import { registerTools } from "./tools/register.js";

async function main() {
  const cfg = loadConfig(process.env);
  const bridge = new Bridge({ port: cfg.port, token: cfg.token, allowedOrigin: cfg.bitrixOrigin });
  await bridge.start();
  console.error(`[bridge] listening on 127.0.0.1:${cfg.port}`);

  const catalog = loadCatalog(cfg.catalogPath);
  const server = new McpServer({ name: "bitrix24-bridge", version: "0.1.0" });
  registerTools(server, { bridge, catalog });

  await server.connect(new StdioServerTransport());
  console.error("[mcp] bitrix24-bridge running on stdio");

  // Exit cleanly when the MCP client (Claude) closes stdio, so the WS port is
  // released instead of lingering as an orphan process (PPID 1) that would
  // block the next spawn with EADDRINUSE.
  const shutdown = async () => {
    try { await bridge.stop(); } finally { process.exit(0); }
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
