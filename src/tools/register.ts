import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallSink } from "../bridge/uds-client.js";
import type { Catalog } from "../catalog/catalog.js";
import { HELP } from "./help.js";
import { randomUUID } from "node:crypto";

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
        "Вызвать разрешённый Bitrix24-вызов по имени из каталога (включая мутирующие — каталог " +
        "является allowlist). Данные актуальны на момент запроса. Имена: " + deps.catalog.names().join(", "),
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
      description:
        "ПОСЛЕДНИЕ N сообщений чата по chatId (по умолчанию 20; im.v2). chatId — из bitrix_chats_recent " +
        "или из ответа bitrix_chat_load. Чтобы листать СТАРЫЕ сообщения вглубь — используй " +
        "bitrix_chat_history: этот метод (im.v2.Chat.Message.list) отдаёт только последнюю страницу и " +
        "назад по курсору НЕ листает.",
      inputSchema: {
        chatId: z.union([z.number(), z.string()]),
        limit: z.number().optional(),
        params: z.record(z.unknown()).optional(),
        portal: z.string().optional(),
      },
      // im.v2.Chat.Message.list returns the latest page only; backward paging lives in
      // ...Message.tail (bitrix_chat_history). filter[lastId] is not honored here — d22adca7
      // hit this: beforeId on .list kept returning the same tail. So we don't expose it.
      toParams: (a) => ({
        chatId: a.chatId,
        limit: a.limit ?? 20, // G8: sane default guards against huge histories
      }),
    },
    {
      tool: "bitrix_task_get_v2",
      catalogName: "task.v2.get",
      description: "Карточка задачи через v2-подсистему scrum-борда (JSON API). taskId — id задачи.",
      inputSchema: { taskId: z.union([z.number(), z.string()]), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      // v2 wraps the id: { task: { id } } — verified by capture (not the flat { task } older notes claimed)
      toParams: (a) => ({ task: { id: a.taskId } }),
    },
    {
      tool: "bitrix_task_scrum_info",
      catalogName: "task.scrum.info",
      description: "Scrum-информация по задаче (спринт, эпик, story points и т.п.; JSON API).",
      inputSchema: { taskId: z.union([z.number(), z.string()]), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: (a) => ({ taskId: a.taskId }),
    },
    {
      tool: "bitrix_task_files",
      catalogName: "task.files",
      description: "Файлы, прикреплённые к задаче(ам) (JSON API). ids — массив id задач.",
      inputSchema: { ids: z.array(z.union([z.number(), z.string()])).min(1), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: (a) => ({ ids: a.ids }),
    },
    {
      tool: "bitrix_task_views_count",
      catalogName: "task.views.count",
      description: "Сколько пользователей просмотрели задачу (JSON API).",
      inputSchema: { taskId: z.union([z.number(), z.string()]), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: (a) => ({ task: { id: a.taskId } }),
    },
    {
      tool: "bitrix_chat_load",
      catalogName: "chat.load",
      description:
        "Открыть чат и получить первые сообщения. Адресация: dialogId = ID пользователя → " +
        'ЛИЧНЫЙ чат 1-на-1; dialogId = "chat"+CHAT_ID (или chatId = CHAT_ID) → ГРУППОВОЙ. ' +
        "Чат по ЗАДАЧЕ: bitrix_task_get → GROUP_ID → bitrix_project_get → CHAT_ID. Не знаешь id — " +
        "найди через bitrix_chats_recent или bitrix_entity_selector. Ответ вернёт числовой chatId — " +
        "передавай его в bitrix_chat_history / bitrix_chat_mark_read. messageLimit по умолчанию 25.",
      inputSchema: {
        chatId: z.union([z.number(), z.string()]).optional(),
        dialogId: z.union([z.number(), z.string()]).optional(),
        messageLimit: z.number().optional(),
        params: z.record(z.unknown()).optional(),
        portal: z.string().optional(),
      },
      toParams: (a) => ({
        ...(a.chatId !== undefined ? { chatId: a.chatId } : {}),
        ...(a.dialogId !== undefined ? { dialogId: a.dialogId } : {}),
        ...(a.messageLimit !== undefined ? { messageLimit: a.messageLimit } : {}),
      }),
    },
    {
      tool: "bitrix_chat_history",
      catalogName: "chat.messages.tail",
      description:
        "Листать историю чата ВГЛУБЬ (старые сообщения). beforeId — минимальный id сообщения из текущей " +
        "страницы; повторяй, уменьшая beforeId, до начала истории. limit по умолчанию 25, порядок — DESC.",
      inputSchema: {
        chatId: z.union([z.number(), z.string()]),
        beforeId: z.union([z.number(), z.string()]).optional(),
        limit: z.number().optional(),
        params: z.record(z.unknown()).optional(),
        portal: z.string().optional(),
      },
      toParams: (a) => ({
        chatId: a.chatId,
        ...(a.beforeId !== undefined ? { "filter[lastId]": a.beforeId } : {}),
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
      }),
    },
    {
      tool: "bitrix_chat_mark_read",
      catalogName: "chat.message.read",
      description:
        "⚠ МУТИРУЮЩИЙ. Пометить сообщения чата прочитанными. ids — массив id сообщений; " +
        "actionUuid генерируется автоматически, если не передан.",
      inputSchema: {
        chatId: z.union([z.number(), z.string()]),
        ids: z.array(z.union([z.number(), z.string()])).min(1),
        actionUuid: z.string().optional(),
        params: z.record(z.unknown()).optional(),
        portal: z.string().optional(),
      },
      toParams: (a) => ({ chatId: a.chatId, ids: a.ids, actionUuid: a.actionUuid ?? randomUUID() }),
    },
    {
      tool: "bitrix_entity_selector",
      catalogName: "entityselector.load",
      description:
        "Поиск/резолв сущностей (пользователи, проекты, чаты) через entityselector (JSON API). " +
        'Найти ЧАТ/диалог: dialog={id:"im-chat-search",context:"IM_CHAT_SEARCH",' +
        'entities:[{id:"im-recent-v2",dynamicLoad:true,dynamicSearch:true}]}. ' +
        'Найти ПОЛЬЗОВАТЕЛЯ: entities:[{id:"user"}]. Свободный текстовый запрос сверь реверсом.',
      inputSchema: { dialog: z.record(z.unknown()), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: (a) => ({ dialog: a.dialog }),
    },
    {
      tool: "bitrix_recent_load",
      catalogName: "recent.load",
      description:
        "Недавние чаты по СЕКЦИИ (im.v2). section: \"tasksTask\" — ЧАТЫ ЗАДАЧ (обсуждения задач; в " +
        "bitrix_chats_recent их нет), \"collab\"/\"collabDefault\" — коллабы, иначе обычные диалоги. " +
        "Отдаёт chatId/dialogId — дальше открывай bitrix_chat_load. Листать глубже — bitrix_recent_tail.",
      inputSchema: {
        section: z.string().optional(),
        limit: z.number().optional(),
        unread: z.boolean().optional(),
        parentId: z.union([z.number(), z.string()]).optional(),
        params: z.record(z.unknown()).optional(),
        portal: z.string().optional(),
      },
      toParams: (a) => ({
        limit: a.limit ?? 50,
        ...(a.section !== undefined ? { "filter[recentSection]": a.section } : {}),
        ...(a.parentId !== undefined ? { "filter[parentId]": a.parentId } : {}),
        "filter[unread]": a.unread ? "Y" : "N",
      }),
    },
    {
      tool: "bitrix_recent_tail",
      catalogName: "recent.tail",
      description:
        "Листать недавние ВГЛУБЬ (im.v2). lastMessageDate — ISO-дата последнего элемента текущей " +
        "страницы (курсор); section — как в bitrix_recent_load. Повторяй, сдвигая lastMessageDate.",
      inputSchema: {
        lastMessageDate: z.string(),
        section: z.string().optional(),
        limit: z.number().optional(),
        unread: z.boolean().optional(),
        params: z.record(z.unknown()).optional(),
        portal: z.string().optional(),
      },
      toParams: (a) => ({
        limit: a.limit ?? 50,
        "filter[lastMessageDate]": a.lastMessageDate,
        ...(a.section !== undefined ? { "filter[recentSection]": a.section } : {}),
        "filter[unread]": a.unread ? "Y" : "N",
      }),
    },
    {
      tool: "bitrix_entity_search",
      catalogName: "entityselector.search",
      description:
        "ТЕКСТОВЫЙ поиск сущностей через entityselector (JSON API). query — строка поиска. По умолчанию " +
        "ищет чаты/диалоги (context IM_CHAT_SEARCH); section: \"tasksTask\" — среди чатов задач, " +
        "\"default\" — среди всех. Для иных сущностей передай свой dialog целиком.",
      inputSchema: {
        query: z.string(),
        section: z.string().optional(),
        dialog: z.record(z.unknown()).optional(),
        params: z.record(z.unknown()).optional(),
        portal: z.string().optional(),
      },
      toParams: (a) => ({
        dialog: a.dialog ?? {
          id: "im-chat-search",
          context: "IM_CHAT_SEARCH",
          entities: [{ id: "im-recent-v2", dynamicLoad: true, dynamicSearch: true, options: { searchRecentSection: a.section ?? "default", parentId: 0 } }],
          preselectedItems: [],
          clearUnavailableItems: false,
        },
        searchQuery: { query: a.query, queryWords: [a.query] },
      }),
    },
    {
      tool: "bitrix_chat_get_dialog_id",
      catalogName: "chat.dialogId",
      description:
        "Резолв dialogId чата по externalId (im.v2). Напр. externalId \"sg\"+<groupId> → dialogId " +
        "чата соцгруппы/проекта. Затем открывай через bitrix_chat_load.",
      inputSchema: { externalId: z.string(), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: (a) => ({ externalId: a.externalId }),
    },
    {
      tool: "bitrix_chat_read_all",
      catalogName: "chat.read.all",
      description: "⚠ МУТИРУЮЩИЙ. Пометить ВСЕ чаты прочитанными (im.v2). Параметров нет.",
      inputSchema: { params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: () => ({}),
    },
    {
      tool: "bitrix_task_subtasks",
      catalogName: "task.subtasks",
      description: "Подзадачи задачи (v2 relations, JSON API). taskId — id родителя. navigation.size управляет страницей.",
      inputSchema: { taskId: z.union([z.number(), z.string()]), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: (a) => ({ taskId: a.taskId, withIds: true, withCompleted: true, withSubTasks: true, navigation: { size: 10 } }),
    },
    {
      tool: "bitrix_task_related",
      catalogName: "task.related",
      description: "Связанные задачи (v2 relations, JSON API). taskId — id задачи.",
      inputSchema: { taskId: z.union([z.number(), z.string()]), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: (a) => ({ taskId: a.taskId, withIds: true, withCompleted: true, withSubTasks: true, navigation: { size: 10 } }),
    },
    {
      tool: "bitrix_user_get",
      catalogName: "im.user.get",
      description: "Карточка пользователя мессенджера по id (имя, аватар, статус). userId — id пользователя.",
      inputSchema: { userId: z.union([z.number(), z.string()]), params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: (a) => ({ ID: a.userId }),
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
