import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge/server.js";
import { loadCatalog } from "./catalog/catalog.js";
import { registerTools } from "./tools/register.js";

async function main() {
  const cfg = loadConfig(process.env);
  const bridge = new Bridge({ port: cfg.port, token: cfg.token });
  await bridge.start();
  console.error(`[bridge] listening on 127.0.0.1:${cfg.port}`);

  const catalog = loadCatalog(cfg.catalogPath);
  const server = new McpServer({ name: "bitrix24-bridge", version: "0.1.0" });
  registerTools(server, { bridge, catalog });

  await server.connect(new StdioServerTransport());
  console.error("[mcp] bitrix24-bridge running on stdio");
}

main().catch((e) => { console.error(e); process.exit(1); });
