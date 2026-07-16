import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallSink } from "../bridge/uds-client.js";
import type { Catalog } from "../catalog/catalog.js";
import { HELP } from "./help.js";

export interface ToolDeps { sink: CallSink; catalog: Catalog; defaultPortal: string; portals: string[]; }

function ok(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data) }] }; }
function fail(message: string) { return { isError: true, content: [{ type: "text" as const, text: message }] }; }

export function registerTools(server: McpServer, deps: ToolDeps): void {
  // Self-describing: any MCP client can call bitrix_help (or read the resource) to learn
  // param conventions, the response envelope, and field names without repo access.
  server.registerTool(
    "bitrix_help",
    {
      description:
        "Справка по этому Bitrix24 MCP: список инструментов, формат ответа, конвенции params " +
        "(select/filter/order/пагинация), имена полей, примеры. Вызови, если не уверен, как формировать params.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text" as const, text: HELP }] }),
  );

  // Same guide as an MCP resource, for clients that surface resources.
  server.registerResource(
    "bitrix-api-guide",
    "bitrix://api-notes",
    { title: "Bitrix24 MCP usage guide", description: "Как пользоваться инструментами: params, поля, формат ответа.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: HELP }] }),
  );

  server.registerTool(
    "bitrix_status",
    {
      description:
        "Диагностика моста (read-only): какие порталы сконфигурированы и какие сейчас подключены " +
        "(открыта залогиненная вкладка с расширением). Помогает понять, почему вызов не проходит.",
      inputSchema: {},
    },
    async () => {
      try {
        const { portals } = await deps.sink.status();
        return ok({ configured: true, defaultPortal: deps.defaultPortal, portals });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "bitrix_call",
    {
      description:
        "Вызвать разрешённый Bitrix24-вызов по имени из каталога (read-only). " +
        "Данные актуальны на момент запроса. Имена: " + deps.catalog.names().join(", "),
      inputSchema: { name: z.string(), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
    },
    async ({ name, params, portal }: { name: string; params?: Record<string, unknown>; portal?: string }) => {
      try {
        const entry = deps.catalog.resolve(name);
        const data = await deps.sink.call(portal ?? deps.defaultPortal, { ...entry, params: { ...entry.params, ...(params ?? {}) } });
        return ok(data);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // Default field selections. Overridable per call via the tool's `params`.
  const TASK_LIST_SELECT = ["ID", "TITLE", "STATUS", "RESPONSIBLE_ID", "CREATED_BY", "DEADLINE", "GROUP_ID", "PRIORITY"];
  const TASK_GET_SELECT = ["ID", "TITLE", "DESCRIPTION", "STATUS", "RESPONSIBLE_ID", "CREATED_BY", "CREATED_DATE", "DEADLINE", "PRIORITY", "GROUP_ID", "CLOSED_DATE"];
  const GROUP_LIST_SELECT = ["ID", "NAME", "DESCRIPTION", "NUMBER_OF_MEMBERS", "OWNER_ID", "DATE_CREATE", "PROJECT"];
  const GROUP_GET_SELECT = ["ID", "NAME", "DESCRIPTION", "OWNER_DATA", "SUBJECT_DATA", "NUMBER_OF_MEMBERS", "DATE_CREATE"];

  // --- typed read tools, each mapped onto a catalog name. Every tool accepts an
  // optional `params` object (Bitrix-native shape) merged LAST, so the agent controls
  // select / filter / order / pagination precisely and can override the defaults below. ---
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
      description:
        "Список задач пользователя (read-only). Точная выборка через params: " +
        'filter (напр. {"RESPONSIBLE_ID":55,"REAL_STATUS":2}), select, order (напр. {"ID":"desc"}), start (сдвиг, шаг 50).',
      inputSchema: { params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: () => ({ select: TASK_LIST_SELECT, order: { ID: "desc" } }),
    },
    {
      tool: "bitrix_task_get",
      catalogName: "task.get",
      description: "Карточка задачи по id (read-only). Поля по умолчанию; изменить через params.select (напр. добавить UF_*, TAGS, TIME_ESTIMATE).",
      inputSchema: { taskId: z.union([z.number(), z.string()]), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: (a) => ({ taskId: a.taskId, select: TASK_GET_SELECT }),
    },
    {
      tool: "bitrix_projects_list",
      catalogName: "projects.list",
      description:
        "Список рабочих групп/проектов с именами (read-only). Точная выборка через params: " +
        'select, order (напр. {"NAME":"asc"}), filter.',
      inputSchema: { params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: () => ({ select: GROUP_LIST_SELECT, order: { NAME: "asc" } }),
    },
    {
      tool: "bitrix_project_get",
      catalogName: "projects.get",
      description: "Полная карточка одной группы/проекта по groupId (read-only): участники, владелец, описание, чат.",
      inputSchema: { groupId: z.union([z.number(), z.string()]), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      // socialnetwork.api.workgroup.get wraps its arguments under `params[...]`
      toParams: (a) => ({ params: { groupId: a.groupId, select: GROUP_GET_SELECT } }),
    },
    {
      tool: "bitrix_chats_recent",
      catalogName: "chats.recent",
      description: 'Недавние чаты/диалоги (read-only). params — доп. фильтры (напр. {"UNREAD_ONLY":"Y"}).',
      inputSchema: { params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: () => ({}),
    },
    {
      tool: "bitrix_chat_messages",
      catalogName: "chat.messages",
      description: "История сообщений чата по chatId (по умолчанию 20 последних; beforeId — листать вглубь). chatId из bitrix_chats_recent (im.v2).",
      inputSchema: {
        chatId: z.union([z.number(), z.string()]),
        limit: z.number().optional(),
        beforeId: z.union([z.number(), z.string()]).optional(),
        params: z.record(z.unknown()).optional(),
        portal: z.string().optional(),
      },
      // im.v2 param names (this portal's messenger): chatId / limit / filter[lastId]
      toParams: (a) => ({
        chatId: a.chatId,
        limit: a.limit ?? 20, // G8: sane default guards against huge histories
        ...(a.beforeId !== undefined ? { "filter[lastId]": a.beforeId } : {}),
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
          // agent-supplied `params` wins over the tool's defaults and the catalog defaults
          const params = { ...entry.params, ...t.toParams(args), ...(args.params ?? {}) };
          const data = await deps.sink.call(args.portal ?? deps.defaultPortal, { ...entry, params });
          return ok(data);
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }
}
