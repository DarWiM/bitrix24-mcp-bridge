import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallSink } from "../bridge/uds-client.js";
import type { Catalog } from "../catalog/catalog.js";
import { HELP } from "./help.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatTranscript, parseCallDetail, type CallDetail } from "./callDetail.js";
import { collectChatCalls, readMessagePage, sortCalls, type ChatCall } from "./chatCalls.js";
import { formatComments, parseComments, parseFirstPage, type TaskComment } from "./taskComments.js";
import { fileNameFromUrl, finalizeDownload, resolveDestination, resolvePortalUrl, tempDownloadPath } from "./download.js";
import { PACKAGE_VERSION } from "../version.js";

export interface ToolDeps {
  sink: CallSink;
  catalog: Catalog;
  defaultPortal: string;
  portals: string[];
  // alias → portal origin; lets tools hand back absolute links (e.g. a call recording).
  origins?: Record<string, string>;
  // Where downloaded attachments land when the caller doesn't pick a path.
  downloadsDir?: string;
}

const textResponse = z.object({ text: z.string() });

// A long meeting's transcript dwarfs everything else in the payload (a 1-hour call: ~70 KB of
// 80 KB). Past this size it goes to disk, where the agent can grep it instead of paying for
// all 333 utterances to find three.
const TRANSCRIPT_INLINE_LIMIT = 20_000;

const TRANSCRIPT_MODES = ["auto", "inline", "file", "none"] as const;
type TranscriptMode = (typeof TRANSCRIPT_MODES)[number];

function shouldSpill(mode: TranscriptMode, call: CallDetail, canWrite: boolean): boolean {
  if (mode === "none" || mode === "inline") return false;
  if (!canWrite) return false; // no downloads dir configured — inline is the only option
  if (mode === "file") return true;
  return JSON.stringify(call.transcript).length > TRANSCRIPT_INLINE_LIMIT;
}
// Same reasoning as the transcript: a long legacy discussion goes to disk, where it can be grepped.
const COMMENTS_INLINE_LIMIT = 20_000;
const COMMENTS_OUTPUT_MODES = ["auto", "inline", "file"] as const;
type CommentsOutputMode = (typeof COMMENTS_OUTPUT_MODES)[number];

const navigateResponse = z.object({ messageList: z.string(), navigation: z.string().optional() });
// Digits only: the task id also names the spill files, so anything path-like must not get through.
const positiveId = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(Number);

const downloadResult = z.object({
  path: z.string(),
  bytes: z.number(),
  contentType: z.string(),
  fileName: z.string().nullable(),
});

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
        // The bundles on disk are refreshed automatically on upgrade, but Chrome keeps running
        // the copy it loaded until someone hits "Обновить" — so a stale extension is reported
        // rather than left to fail later with a confusing error.
        const stale = portals.filter((p) => p.connected && p.extensionVersion !== PACKAGE_VERSION);
        return ok({
          configured: true,
          defaultPortal: deps.defaultPortal,
          packageVersion: PACKAGE_VERSION,
          portals,
          ...(stale.length > 0
            ? {
                warning:
                  `расширение устарело (${stale.map((p) => `${p.alias}: ${p.extensionVersion ?? "до 0.3.0"}`).join(", ")}), ` +
                  `мост версии ${PACKAGE_VERSION}. Файлы уже обновлены — нажми «Обновить» на расширении в chrome://extensions ` +
                  "и перезагрузи вкладку портала, иначе новые методы работать не будут.",
              }
            : {}),
        });
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
  const TASK_GET_SELECT = ["ID", "TITLE", "DESCRIPTION", "STATUS", "RESPONSIBLE_ID", "CREATED_BY", "CREATED_DATE", "DEADLINE", "PRIORITY", "GROUP_ID", "CLOSED_DATE", "CHAT_ID"];
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
        "Список задач (read-only). params.filter — поля можно с операторами: \"!\" (исключить), " +
        '"<"/">"/"<="/">=", "%" (подстрока). Напр. {"!REAL_STATUS":5} — незакрытые, ' +
        '{">=DEADLINE":"2026-07-01"}. Роли участника РАЗДЕЛЬНЫ и в фильтре в ЕД. числе: ' +
        "RESPONSIBLE_ID (ответственный), ACCOMPLICE (соисполнитель), AUDITOR (наблюдатель), " +
        'CREATED_BY (постановщик). «Все мои задачи» = объединить вызовы по RESPONSIBLE_ID и ' +
        'ACCOMPLICE (одного поля «любая роль» нет; задача может попасть сразу в несколько — дедуплицируй по id). ' +
        'ПАГИНАЦИЯ: params.PAGEN_1 — НОМЕР страницы (1, 2, 3…), страница = 20 задач; params.start НЕ работает ' +
        '(вернёт ту же первую страницу). СТАТУС: в select проси "STATUS" (он в дефолтном select) — придёт ключ ' +
        '"status" по шкале 1..7; "REAL_STATUS" в select молча не возвращается, но в filter работает. ' +
        'Ещё params: select, order — дефолт этой обёртки {"ID":"desc"}.',
      inputSchema: { params: z.record(z.unknown()).optional(), portal: z.string().optional() },
      toParams: () => ({ select: TASK_LIST_SELECT, order: { ID: "desc" } }),
    },
    {
      tool: "bitrix_task_get",
      catalogName: "task.get",
      description:
        "Карточка задачи по id (read-only). В дефолтном select есть CHAT_ID — это id ЧАТА-ОБСУЖДЕНИЯ " +
        "задачи: прямой путь к нему = bitrix_chat_load { chatId: <CHAT_ID> } (не путать с чатом проекта " +
        "через GROUP_ID). Другие поля — через params.select (напр. UF_*, TAGS, TIME_ESTIMATE). " +
        "У старых задач обсуждение может быть НЕ в чате, а в форуме: COMMENTS_COUNT > 0 при пустом чате → " +
        "bitrix_task_comments { taskId }.",
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
      description:
        "НЕДАВНИЕ чаты/диалоги (read-only) — только последние и БЕЗ чатов задач. Чтобы НАЙТИ " +
        "конкретный чат по названию/имени — bitrix_entity_search; чаты задач — bitrix_recent_load " +
        '{ section:"tasksTask" }. params — доп. фильтры (напр. {"UNREAD_ONLY":"Y"}).',
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
        'ЛИЧНЫЙ чат 1-на-1 с ним; dialogId = "chat"+CHAT_ID (или chatId = CHAT_ID) → ГРУППОВОЙ. ' +
        "Чат С ЧЕЛОВЕКОМ по имени: сперва bitrix_entity_search { query } → вернёт dialogId (=userId). " +
        "Чат ЗАДАЧИ: bitrix_recent_load { section:\"tasksTask\" } либо bitrix_entity_search. " +
        "Чат ПРОЕКТА: bitrix_task_get → GROUP_ID → bitrix_project_get → CHAT_ID. " +
        "Ответ вернёт числовой chatId — передавай его в bitrix_chat_history / bitrix_chat_mark_read. " +
        "messageLimit по умолчанию 25.",
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
        "ТЕКСТОВЫЙ поиск чатов/диалогов по строке (entityselector, JSON API) — ГЛАВНЫЙ способ найти " +
        "чат по названию или человека по ИМЕНИ. query — строка поиска. Поиск по имени человека вернёт " +
        "ЛИЧНЫЙ диалог с ним — его dialogId (= userId); открывай bitrix_chat_load { dialogId }. " +
        "section: \"tasksTask\" — среди чатов задач, \"default\" (умолч.) — среди всех диалогов. " +
        "Для иных сущностей передай свой dialog целиком.",
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
    {
      tool: "bitrix_entity_chat",
      catalogName: "im.chat.get",
      description:
        "Резолв chatId чата, ПРИВЯЗАННОГО к объекту (im.chat.get). entityType/entityId — тип и id " +
        'объекта: "TASKS_TASK" (чат-обсуждение задачи), "SONET_GROUP" (чат группы/проекта), "CRM", ' +
        '"CALENDAR", "MAIL", "VIDEOCONF", "LINES", "CALL". Даёт прямой «объект → chatId» без поиска по ' +
        "названию. Для задачи проще всё же CHAT_ID из bitrix_task_get; этот инструмент — общий, на любую " +
        "сущность. Полученный chatId открывай bitrix_chat_load { chatId }.",
      inputSchema: {
        entityType: z.string(),
        entityId: z.union([z.number(), z.string()]),
        params: z.record(z.unknown()).optional(),
        portal: z.string().optional(),
      },
      toParams: (a) => ({ ENTITY_TYPE: a.entityType, ENTITY_ID: a.entityId }),
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

  // --- calls. Unlike everything above, the call analysis lives in a server-rendered slider
  // (HTML), so the catalog entry opts into responseType "text" and we parse it here. ---
  if (available.has("call.detail")) {
    server.registerTool(
      "bitrix_call_detail",
      {
        description:
          "ВСЁ по видеозвонку/созвону по его callId: тема, дата, длительность, участники (доля " +
          "разговора, оценка, рекомендации), оценка встречи, решения («что решили»), задачи с " +
          "исполнителями, резюме по главам с таймкодами, ПОЛНАЯ РАСШИФРОВКА по репликам и ссылка на " +
          "аудиозапись. callId берётся из системного сообщения чата «Начат звонок №N» (см. " +
          "bitrix_chat_calls) или из ссылки /call/detail/<callId>. " +
          "ДЛИННАЯ расшифровка по умолчанию НЕ приходит в ответе, а сохраняется на диск: тогда " +
          "transcript пуст, а пути лежат в files — files.transcript (текст, строка = реплика с " +
          "таймкодом и спикером: удобно грепать и читать кусками) и files.json (полный ответ). " +
          "transcript: \"inline\" — вернуть расшифровку в ответе (может быть очень объёмной), " +
          "\"file\" — всегда в файл, \"none\" — не нужна вовсе, \"auto\" (умолчание) — по размеру. " +
          "Требует, чтобы у пользователя был доступ к звонку.",
        inputSchema: {
          callId: z.union([z.number(), z.string()]),
          transcript: z.enum(TRANSCRIPT_MODES).optional(),
          params: z.record(z.unknown()).optional(),
          portal: z.string().optional(),
        },
      },
      async ({ callId, transcript, params, portal }: { callId: number | string; transcript?: TranscriptMode; params?: Record<string, unknown>; portal?: string }) => {
        try {
          const entry = deps.catalog.resolve("call.detail");
          const alias = portal ?? deps.defaultPortal;
          const raw = await deps.sink.call(alias, { ...entry, params: { ...entry.params, callId, ...(params ?? {}) } });
          const page = textResponse.safeParse(raw);
          if (!page.success) return fail("call.detail did not return text — is responseType \"text\" set in the catalog?");
          const mode = transcript ?? "auto";
          const call = parseCallDetail(page.data.text, { origin: deps.origins?.[alias], transcript: mode !== "none" });
          if (!shouldSpill(mode, call, deps.downloadsDir !== undefined)) return ok(call);

          const dir = deps.downloadsDir!;
          mkdirSync(dir, { recursive: true });
          const files = {
            transcript: join(dir, `call-${call.id}-transcript.txt`),
            json: join(dir, `call-${call.id}.json`),
          };
          writeFileSync(files.transcript, formatTranscript(call), "utf8");
          // The JSON copy keeps the transcript — it is the archive, not the context-sized reply.
          writeFileSync(files.json, JSON.stringify(call, null, 1), "utf8");
          return ok({ ...call, transcript: [], files });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  // --- legacy task comments: the forum discussion tasks had before task chats. The first page is a
  // server-rendered slider that also mints the signed parameters navigateComment needs. ---
  if (available.has("task.comments.page") && available.has("task.comments.navigate")) {
    server.registerTool(
      "bitrix_task_comments",
      {
        description:
          "СТАРЫЕ комментарии задачи (форум) — обсуждение, которое было у задачи до перехода на чаты задач. " +
          "Признак: у задачи COMMENTS_COUNT > 0 (bitrix_task_get с params.select), а в чате задачи " +
          "(CHAT_ID → bitrix_chat_load) только системное сообщение «Чтобы прочитать комментарии, которые " +
          "ранее оставили…». Отдаёт комментарии по порядку (старые → новые): { id, authorId, author, date, " +
          "dateIso, text, isNew, system, files[] }; system: true — служебные (смена срока, «назначены " +
          "исполнителем», пинги); files[].url — ссылка для bitrix_file_download. НИЧЕГО не помечает " +
          "прочитанным. Сам листает до начала истории (maxPages, по умолчанию 10); если в ответе " +
          "reachedHistoryStart:false — продолжи с beforeId: <oldestId>. limit — вернуть только N последних. " +
          "ДЛИННОЕ обсуждение по умолчанию сохраняется на диск: тогда comments пуст, а пути в files — " +
          "files.text (строка = комментарий с id, датой и автором — удобно грепать) и files.json. " +
          "output: \"inline\" — всегда в ответе, \"file\" — всегда в файл, \"auto\" (умолчание) — по размеру.",
        inputSchema: {
          taskId: z.union([z.number(), z.string()]),
          limit: z.number().int().positive().optional(),
          maxPages: z.number().int().positive().optional(),
          beforeId: z.union([z.number(), z.string()]).optional(),
          output: z.enum(COMMENTS_OUTPUT_MODES).optional(),
          portal: z.string().optional(),
        },
      },
      async (args: {
        taskId: number | string; limit?: number; maxPages?: number; beforeId?: number | string; output?: CommentsOutputMode; portal?: string;
      }) => {
        const { limit, maxPages, output, portal } = args;
        const taskIdArg = positiveId.safeParse(args.taskId);
        const beforeIdArg = positiveId.optional().safeParse(args.beforeId);
        if (!taskIdArg.success) return fail(`taskId must be a positive integer, got ${JSON.stringify(args.taskId)}`);
        if (!beforeIdArg.success) return fail(`beforeId must be a positive integer, got ${JSON.stringify(args.beforeId)}`);
        const taskId = taskIdArg.data;
        const beforeId = beforeIdArg.data;
        try {
          const alias = portal ?? deps.defaultPortal;
          const origin = deps.origins?.[alias];
          const pageEntry = deps.catalog.resolve("task.comments.page");
          const raw = await deps.sink.call(alias, { ...pageEntry, params: { ...pageEntry.params, taskId } });
          const page = textResponse.safeParse(raw);
          if (!page.success) return fail("task.comments.page did not return text — is responseType \"text\" set in the catalog?");
          const first = parseFirstPage(page.data.text, origin);

          const byId = new Map<number, TaskComment>();
          const before = beforeId ?? null;
          // Continuing a previous run: the first page is fetched only for its fresh signature.
          if (before === null) for (const c of first.comments) byId.set(c.id, c);
          let cursor = before ?? (first.comments[0]?.id ?? null);
          let reachedHistoryStart = before === null && !first.hasOlder;
          let scannedPages = 0;
          const navEntry = deps.catalog.resolve("task.comments.navigate");
          while (!reachedHistoryStart && cursor !== null && scannedPages < (maxPages ?? 10)) {
            if (limit !== undefined && byId.size >= limit) break;
            const rawNav = await deps.sink.call(alias, {
              ...navEntry,
              params: {
                ...navEntry.params,
                ENTITY_XML_ID: `TASK_${taskId}`,
                EXEMPLAR_ID: first.exemplarId,
                "FILTER[<ID]": cursor,
                taskId,
                signedParameters: first.signedParameters,
              },
            });
            const nav = navigateResponse.safeParse(rawNav);
            if (!nav.success) return fail("task.comments.navigate returned an unexpected shape (no messageList)");
            scannedPages += 1;
            const older = parseComments(nav.data.messageList, origin).filter((c) => !byId.has(c.id));
            for (const c of older) byId.set(c.id, c);
            if (older.length > 0) cursor = older[0].id;
            // navigation carries the "load more" markup; it is empty once the oldest comment is in.
            if (older.length === 0 || !nav.data.navigation?.trim()) reachedHistoryStart = true;
          }

          const loaded = [...byId.values()].sort((a, b) => a.id - b.id);
          const comments = limit !== undefined ? loaded.slice(-limit) : loaded;
          // Older comments cut off by `limit` are not "the start of history" from the caller's side.
          if (comments.length < loaded.length) reachedHistoryStart = false;
          const result = {
            taskId,
            total: comments.length,
            reachedHistoryStart,
            oldestId: comments[0]?.id ?? null,
            scannedPages,
            comments,
          };

          const mode = output ?? "auto";
          const spill = deps.downloadsDir !== undefined &&
            (mode === "file" || (mode === "auto" && JSON.stringify(comments).length > COMMENTS_INLINE_LIMIT));
          if (!spill) return ok(result);

          const dir = deps.downloadsDir!;
          mkdirSync(dir, { recursive: true });
          const files = {
            text: join(dir, `task-${taskId}-comments.txt`),
            json: join(dir, `task-${taskId}-comments.json`),
          };
          writeFileSync(files.text, formatComments(taskId, comments, reachedHistoryStart), "utf8");
          writeFileSync(files.json, JSON.stringify(result, null, 1), "utf8");
          return ok({ ...result, comments: [], files });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  // --- downloads. The portal mints signed, single-file URLs, so these tools take a URL and
  // check its origin instead of resolving a catalog name. The body never enters the agent's
  // context: the daemon streams it to disk and only the path comes back. ---
  if (deps.downloadsDir) {
    const downloadsDir = deps.downloadsDir;

    const fetchToDisk = async (args: {
      url: string;
      savePath?: string;
      overwrite?: boolean;
      fallbackName: string;
      portal?: string;
    }) => {
      const origins = deps.origins ?? {};
      const target = resolvePortalUrl(args.url, origins);
      // With no savePath the final name is unknown until the portal answers, so the body lands
      // in a temp file and is moved into place afterwards (see finalizeDownload).
      const explicitPath = args.savePath !== undefined
        ? resolveDestination({ savePath: args.savePath, downloadsDir, suggestedName: args.fallbackName, overwrite: args.overwrite })
        : null;
      const savePath = explicitPath ?? tempDownloadPath(downloadsDir);
      const raw = await deps.sink.call(args.portal ?? target.portal, {
        endpoint: target.endpoint,
        action: null,
        method: "GET",
        params: {},
        responseType: "binary",
        savePath,
      });
      const done = downloadResult.safeParse(raw);
      if (!done.success) return raw;
      if (explicitPath) return done.data;
      return {
        ...done.data,
        path: finalizeDownload({
          tempPath: done.data.path,
          serverName: done.data.fileName,
          fallbackName: fileNameFromUrl(args.url, args.fallbackName),
          downloadsDir,
          overwrite: args.overwrite,
        }),
      };
    };

    server.registerTool(
      "bitrix_file_download",
      {
        description:
          "Скачать ФАЙЛ с портала на диск: вложение чата (фото/видео/документ), файл задачи, " +
          "аудиозапись звонка. url — готовая ссылка из ответа моста: files[].urlDownload у " +
          "bitrix_chat_load, ссылки из bitrix_task_files, recording.url у bitrix_call_detail. " +
          "Скачать может только браузерная сессия, поэтому качает расширение; содержимое файла в " +
          "ответ НЕ попадает — возвращается путь на диске. По умолчанию кладёт в " +
          "~/.bitrix24-mcp-bridge/downloads/; savePath — свой путь (абсолютный либо имя файла " +
          "внутри папки загрузок), overwrite: true — перезаписать существующий.",
        inputSchema: {
          url: z.string(),
          savePath: z.string().optional(),
          overwrite: z.boolean().optional(),
          portal: z.string().optional(),
        },
      },
      async ({ url, savePath, overwrite, portal }: { url: string; savePath?: string; overwrite?: boolean; portal?: string }) => {
        try {
          return ok(await fetchToDisk({ url, savePath, overwrite, portal, fallbackName: "bitrix-file" }));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );

    if (available.has("call.detail")) {
      server.registerTool(
        "bitrix_call_recording",
        {
          description:
            "Скачать АУДИОЗАПИСЬ созвона по callId: сам находит ссылку в деталях звонка и сохраняет " +
            "файл на диск (в ответ возвращается путь, не содержимое). Записи есть не у всех звонков — " +
            "если её нет, вернётся понятная ошибка. savePath/overwrite — как в bitrix_file_download.",
          inputSchema: {
            callId: z.union([z.number(), z.string()]),
            savePath: z.string().optional(),
            overwrite: z.boolean().optional(),
            portal: z.string().optional(),
          },
        },
        async ({ callId, savePath, overwrite, portal }: { callId: number | string; savePath?: string; overwrite?: boolean; portal?: string }) => {
          try {
            const entry = deps.catalog.resolve("call.detail");
            const alias = portal ?? deps.defaultPortal;
            const raw = await deps.sink.call(alias, { ...entry, params: { ...entry.params, callId } });
            const page = textResponse.safeParse(raw);
            if (!page.success) return fail("call.detail did not return text — is responseType \"text\" set in the catalog?");
            const detail = parseCallDetail(page.data.text, { origin: deps.origins?.[alias], transcript: false });
            if (!detail.recording?.url) return fail(`call ${callId} has no recording`);
            return ok(await fetchToDisk({
              url: detail.recording.url,
              savePath,
              overwrite,
              portal: alias,
              fallbackName: `call-${detail.id}.mp3`,
            }));
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      );
    }
  }

  if (available.has("chat.messages.tail")) {
    server.registerTool(
      "bitrix_chat_calls",
      {
        description:
          "Найти ЗВОНКИ/СОЗВОНЫ в чате: листает историю назад и собирает системные сообщения «Начат " +
          "звонок №N» вместе с привязанным резюме BitrixGPT. Отдаёт callId — их скармливай " +
          "bitrix_call_detail. Поиска звонков по порталу целиком нет, поэтому ищи в конкретном чате: " +
          "chatId проекта — bitrix_project_get → CHAT_ID, чат задачи — CHAT_ID из bitrix_task_get. " +
          "Просматривает maxPages страниц по 50 сообщений (по умолчанию 6 ≈ 300 сообщений); если в " +
          "ответе reachedHistoryStart:false, история НЕ дочитана до конца — продолжай с " +
          "beforeId: <oldestScannedMessageId> или увеличь maxPages.",
        inputSchema: {
          chatId: z.union([z.number(), z.string()]),
          limit: z.number().optional(),
          maxPages: z.number().optional(),
          beforeId: z.union([z.number(), z.string()]).optional(),
          params: z.record(z.unknown()).optional(),
          portal: z.string().optional(),
        },
      },
      async ({ chatId, limit, maxPages, beforeId, params, portal }: { chatId: number | string; limit?: number; maxPages?: number; beforeId?: number | string; params?: Record<string, unknown>; portal?: string }) => {
        try {
          const entry = deps.catalog.resolve("chat.messages.tail");
          const alias = portal ?? deps.defaultPortal;
          const wanted = limit ?? 20;
          const pageBudget = maxPages ?? 6;
          const found = new Map<number, ChatCall>();
          let cursor: number | string | null = beforeId ?? null;
          let scannedPages = 0;
          let scannedMessages = 0;
          let reachedHistoryStart = false;
          while (scannedPages < pageBudget) {
            const raw = await deps.sink.call(alias, {
              ...entry,
              params: {
                ...entry.params,
                chatId,
                limit: 50,
                ...(cursor !== null ? { "filter[lastId]": cursor } : {}),
                ...(params ?? {}),
              },
            });
            const page = readMessagePage(raw);
            collectChatCalls(page.messages, found);
            scannedPages += 1;
            scannedMessages += page.messages.length;
            cursor = page.oldestId;
            if (!page.hasNextPage || page.oldestId === null) {
              reachedHistoryStart = true;
              break;
            }
            if (found.size >= wanted) break;
          }
          return ok({
            chatId,
            calls: sortCalls(found).slice(0, wanted),
            scannedPages,
            scannedMessages,
            oldestScannedMessageId: cursor,
            reachedHistoryStart,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }
}
