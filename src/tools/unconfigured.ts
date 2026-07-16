import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HELP } from "./help.js";

// Tools registered when there is no config.json yet. The bridge still starts on stdio
// (so `claude mcp` shows it connected) and guides the user to run console setup —
// configuration never happens in-chat (design: unconfigured state).
export function registerUnconfiguredTools(server: McpServer, reason: string): void {
  server.registerTool(
    "bitrix_help",
    {
      description:
        "Справка по этому Bitrix24 MCP. Сейчас мост не настроен — сначала выполните `bitrix24-bridge setup`.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text" as const, text: HELP }] }),
  );

  server.registerTool(
    "bitrix_status",
    {
      description: "Диагностика моста (read-only): состояние конфигурации.",
      inputSchema: {},
    },
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          configured: false,
          reason,
          hint: "Мост не настроен. Выполните в терминале: bitrix24-bridge setup",
        }),
      }],
    }),
  );
}
