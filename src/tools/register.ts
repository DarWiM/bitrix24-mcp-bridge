import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge/server.js";
import type { Catalog } from "../catalog/catalog.js";

export interface ToolDeps { bridge: Pick<Bridge, "call">; catalog: Catalog; }

function ok(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data) }] }; }
function fail(message: string) { return { isError: true, content: [{ type: "text" as const, text: message }] }; }

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "bitrix_call",
    {
      description:
        "Вызвать разрешённый Bitrix24-вызов по имени из каталога (read-only). " +
        "Данные актуальны на момент запроса. Имена: " + deps.catalog.names().join(", "),
      inputSchema: { name: z.string(), params: z.record(z.unknown()).optional() },
    },
    async ({ name, params }: { name: string; params?: Record<string, unknown> }) => {
      try {
        const entry = deps.catalog.resolve(name);
        const data = await deps.bridge.call({ ...entry, params: { ...entry.params, ...(params ?? {}) } });
        return ok(data);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
