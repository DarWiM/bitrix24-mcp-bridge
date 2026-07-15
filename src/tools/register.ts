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

  // --- typed read tools, each mapped onto a catalog name ---
  const typed: Array<{
    tool: string;
    catalogName: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    toParams: (args: any) => Record<string, unknown>;
  }> = [
    {
      tool: "bitrix_tasks_list",
      catalogName: "tasks.list",
      description: "Список задач пользователя (read-only, актуально на момент запроса)",
      inputSchema: { page: z.number().optional() },
      toParams: (a) => (a.page !== undefined ? { PAGE: a.page } : {}),
    },
    {
      tool: "bitrix_task_get",
      catalogName: "task.get",
      description: "Карточка одной задачи по id",
      inputSchema: { taskId: z.union([z.number(), z.string()]) },
      toParams: (a) => ({ taskId: a.taskId }),
    },
    {
      tool: "bitrix_projects_list",
      catalogName: "projects.list",
      description: "Список рабочих групп/проектов пользователя",
      inputSchema: { page: z.number().optional() },
      toParams: (a) => (a.page !== undefined ? { PAGE: a.page } : {}),
    },
    {
      tool: "bitrix_chats_recent",
      catalogName: "chats.recent",
      description: "Недавние чаты/диалоги пользователя",
      inputSchema: {},
      toParams: () => ({}),
    },
    {
      tool: "bitrix_chat_messages",
      catalogName: "chat.messages",
      description: "История сообщений диалога (по умолчанию 20 последних; beforeId — для листания вглубь)",
      inputSchema: {
        dialogId: z.string(),
        limit: z.number().optional(),
        beforeId: z.number().optional(),
      },
      toParams: (a) => ({
        DIALOG_ID: a.dialogId,
        LIMIT: a.limit ?? 20, // G8: sane default guards against huge histories
        ...(a.beforeId !== undefined ? { FIRST_ID: a.beforeId } : {}),
      }),
    },
  ];

  const available = new Set(deps.catalog.names());
  for (const t of typed) {
    if (!available.has(t.catalogName)) continue; // catalog not (yet) reversed for this domain
    server.registerTool(
      t.tool,
      { description: t.description, inputSchema: t.inputSchema },
      async (args: any) => {
        try {
          const entry = deps.catalog.resolve(t.catalogName);
          const data = await deps.bridge.call({ ...entry, params: { ...entry.params, ...t.toParams(args) } });
          return ok(data);
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }
}
