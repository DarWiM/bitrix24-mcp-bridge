import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CallTarget } from "../../shared/wire.js";
import { agentParams, defineOperation, type OpContext, type Operation } from "./operation.js";

const AJAX = "/bitrix/services/main/ajax.php";

// A Bitrix24 request target with the defaults most calls share.
export function callTarget(entry: Pick<CallTarget, "method"> & Partial<CallTarget>): CallTarget {
  return { endpoint: AJAX, action: null, params: {}, bodyType: "form", responseType: "json", ...entry };
}

const TASKS_LIST = callTarget({ action: "tasks.task.list", method: "POST" });
const TASK_GET = callTarget({ action: "tasks.task.get", method: "POST" });
export const TASK_V2_GET = callTarget({ action: "tasks.v2.Task.get", method: "POST", bodyType: "json" });
const TASK_SCRUM_INFO = callTarget({ action: "tasks.v2.Scrum.getTaskInfo", method: "POST", bodyType: "json" });
const TASK_FILES = callTarget({ action: "tasks.v2.File.listObjects", method: "POST", bodyType: "json" });
const TASK_VIEWS_COUNT = callTarget({ action: "tasks.v2.Task.View.User.count", method: "POST", bodyType: "json" });
const TASK_SUBTASKS = callTarget({ action: "tasks.v2.Task.Relation.Child.list", method: "POST", bodyType: "json" });
export const TASK_RELATED = callTarget({ action: "tasks.v2.Task.Relation.Related.list", method: "POST", bodyType: "json" });
const PROJECTS_LIST = callTarget({ action: "socialnetwork.api.workgroup.list", method: "POST" });
export const PROJECTS_GET = callTarget({ action: "socialnetwork.api.workgroup.get", method: "POST" });
const CHATS_RECENT = callTarget({
  endpoint: "/rest/im.recent.list.json",
  method: "POST",
  params: { LIMIT: 50, SKIP_OPENLINES: "Y", GET_ORIGINAL_TEXT: "Y", PARSE_TEXT: "Y", WITH_COUNTERS: "N" },
});
const CHAT_LOAD = callTarget({ action: "im.v2.Chat.load", method: "POST", params: { messageLimit: 25 } });
const CHAT_MESSAGES = callTarget({ action: "im.v2.Chat.Message.list", method: "POST" });
export const CHAT_MESSAGES_TAIL = callTarget({
  action: "im.v2.Chat.Message.tail",
  method: "POST",
  params: { "order[id]": "DESC", limit: 25 },
});
const CHAT_MESSAGE_READ = callTarget({ action: "im.v2.Chat.Message.read", method: "POST" });
const ENTITYSELECTOR_LOAD = callTarget({ action: "ui.entityselector.load", method: "POST", bodyType: "json" });
const ENTITYSELECTOR_SEARCH = callTarget({ action: "ui.entityselector.doSearch", method: "POST", bodyType: "json" });
const RECENT_LOAD = callTarget({ action: "im.v2.Recent.load", method: "POST" });
const RECENT_TAIL = callTarget({ action: "im.v2.Recent.tail", method: "POST" });
const CHAT_DIALOG_ID = callTarget({ action: "im.v2.Chat.getDialogId", method: "POST" });
const CHAT_READ_ALL = callTarget({ action: "im.v2.Chat.readAll", method: "POST" });
const IM_USER_GET = callTarget({ endpoint: "/rest/im.user.get.json", method: "POST" });
const IM_CHAT_GET = callTarget({ endpoint: "/rest/im.chat.get.json", method: "POST" });

// Default field selections. Overridable per call via the operation's `params`.
const TASK_LIST_SELECT = ["ID", "TITLE", "STATUS", "RESPONSIBLE_ID", "CREATED_BY", "DEADLINE", "GROUP_ID", "PRIORITY"];
const TASK_GET_SELECT = ["ID", "TITLE", "DESCRIPTION", "STATUS", "RESPONSIBLE_ID", "CREATED_BY", "CREATED_DATE", "DEADLINE", "PRIORITY", "GROUP_ID", "CLOSED_DATE", "CHAT_ID"];
const GROUP_LIST_SELECT = ["ID", "NAME", "DESCRIPTION", "NUMBER_OF_MEMBERS", "OWNER_ID", "DATE_CREATE", "PROJECT"];
const GROUP_GET_SELECT = ["ID", "NAME", "DESCRIPTION", "OWNER_DATA", "SUBJECT_DATA", "NUMBER_OF_MEMBERS", "DATE_CREATE"];

const params = agentParams();
// A fresh schema per field: zod-to-json-schema turns a reused instance into a `$ref` to the first
// field, and the tool's JSON Schema should stay as plain as it was.
const anyId = () => z.union([z.number(), z.string()]);

// Every read accepts an optional `params` object (Bitrix-native shape) merged LAST, so the agent
// controls select / filter / order / pagination precisely and can override the defaults.
function send(ctx: OpContext, target: CallTarget, own: Record<string, unknown>, agent: Record<string, unknown> | undefined) {
  return ctx.call({ ...target, params: { ...target.params, ...own, ...(agent ?? {}) } });
}

export const READ_OPERATIONS: Operation[] = [
  defineOperation({
    name: "tasks_list",
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
    mutating: false,
    input: { params },
    run: (ctx, a) => send(ctx, TASKS_LIST, { select: TASK_LIST_SELECT, order: { ID: "desc" } }, a.params),
  }),
  defineOperation({
    name: "task_get",
    description:
      "Карточка задачи по id (read-only). В дефолтном select есть CHAT_ID — это id ЧАТА-ОБСУЖДЕНИЯ " +
      "задачи: прямой путь к нему = bitrix_chat_load { chatId: <CHAT_ID> } (не путать с чатом проекта " +
      "через GROUP_ID). Другие поля — через params.select (напр. UF_*, TAGS, TIME_ESTIMATE). " +
      "У старых задач обсуждение может быть НЕ в чате, а в форуме: COMMENTS_COUNT > 0 при пустом чате → " +
      "bitrix_task_comments { taskId }.",
    mutating: false,
    input: { taskId: anyId(), params },
    run: (ctx, a) => send(ctx, TASK_GET, { taskId: a.taskId, select: TASK_GET_SELECT }, a.params),
  }),
  defineOperation({
    name: "projects_list",
    description:
      "Список рабочих групп/проектов с именами (read-only). Точная выборка через params: " +
      'select, order (напр. {"NAME":"asc"}), filter.',
    mutating: false,
    input: { params },
    run: (ctx, a) => send(ctx, PROJECTS_LIST, { select: GROUP_LIST_SELECT, order: { NAME: "asc" } }, a.params),
  }),
  defineOperation({
    name: "project_get",
    description: "Полная карточка одной группы/проекта по groupId (read-only): участники, владелец, описание, чат.",
    mutating: false,
    input: { groupId: anyId(), params },
    // socialnetwork.api.workgroup.get wraps its arguments under `params[...]`
    run: (ctx, a) => send(ctx, PROJECTS_GET, { params: { groupId: a.groupId, select: GROUP_GET_SELECT } }, a.params),
  }),
  defineOperation({
    name: "chats_recent",
    description:
      "НЕДАВНИЕ чаты/диалоги (read-only) — только последние и БЕЗ чатов задач. Чтобы НАЙТИ " +
      "конкретный чат по названию/имени — bitrix_entity_search; чаты задач — bitrix_recent_load " +
      '{ section:"tasksTask" }. params — доп. фильтры (напр. {"UNREAD_ONLY":"Y"}).',
    mutating: false,
    input: { params },
    run: (ctx, a) => send(ctx, CHATS_RECENT, {}, a.params),
  }),
  defineOperation({
    name: "chat_messages",
    description:
      "ПОСЛЕДНИЕ N сообщений чата по chatId (по умолчанию 20; im.v2). chatId — из bitrix_chats_recent " +
      "или из ответа bitrix_chat_load. Чтобы листать СТАРЫЕ сообщения вглубь — используй " +
      "bitrix_chat_history: этот метод (im.v2.Chat.Message.list) отдаёт только последнюю страницу и " +
      "назад по курсору НЕ листает.",
    mutating: false,
    input: { chatId: anyId(), limit: z.number().optional(), params },
    // im.v2.Chat.Message.list returns the latest page only; backward paging lives in
    // ...Message.tail (chat_history). filter[lastId] is not honored here — beforeId on .list
    // kept returning the same tail. So we don't expose it.
    run: (ctx, a) => send(ctx, CHAT_MESSAGES, { chatId: a.chatId, limit: a.limit ?? 20 }, a.params),
  }),
  defineOperation({
    name: "task_get_v2",
    description: "Карточка задачи через v2-подсистему scrum-борда (JSON API). taskId — id задачи.",
    mutating: false,
    input: { taskId: anyId(), params },
    // v2 wraps the id: { task: { id } } — verified by capture (not the flat { task } older notes claimed)
    run: (ctx, a) => send(ctx, TASK_V2_GET, { task: { id: a.taskId } }, a.params),
  }),
  defineOperation({
    name: "task_scrum_info",
    description: "Scrum-информация по задаче (спринт, эпик, story points и т.п.; JSON API).",
    mutating: false,
    input: { taskId: anyId(), params },
    run: (ctx, a) => send(ctx, TASK_SCRUM_INFO, { taskId: a.taskId }, a.params),
  }),
  defineOperation({
    name: "task_files",
    description:
      "Файлы задачи (JSON API). ids — массив id ПРИКРЕПЛЁННЫХ ОБЪЕКТОВ, НЕ id задач (с id задач вернётся " +
      "пустой список без ошибки): возьми их из поля UF_TASK_WEBDAV_FILES задачи — bitrix_task_get с " +
      'params.select: ["UF_TASK_WEBDAV_FILES"]. downloadUrl в ответе относительный — допиши к нему origin ' +
      "портала, прежде чем передать в bitrix_file_download.",
    mutating: false,
    input: { ids: z.array(anyId()).min(1), params },
    run: (ctx, a) => send(ctx, TASK_FILES, { ids: a.ids }, a.params),
  }),
  defineOperation({
    name: "task_views_count",
    description: "Сколько пользователей просмотрели задачу (JSON API).",
    mutating: false,
    input: { taskId: anyId(), params },
    run: (ctx, a) => send(ctx, TASK_VIEWS_COUNT, { task: { id: a.taskId } }, a.params),
  }),
  defineOperation({
    name: "chat_load",
    description:
      "Открыть чат и получить первые сообщения. Адресация: dialogId = ID пользователя → " +
      'ЛИЧНЫЙ чат 1-на-1 с ним; dialogId = "chat"+CHAT_ID (или chatId = CHAT_ID) → ГРУППОВОЙ. ' +
      "Чат С ЧЕЛОВЕКОМ по имени: сперва bitrix_entity_search { query } → вернёт dialogId (=userId). " +
      "Чат ЗАДАЧИ: bitrix_recent_load { section:\"tasksTask\" } либо bitrix_entity_search. " +
      "Чат ПРОЕКТА: bitrix_task_get → GROUP_ID → bitrix_project_get → CHAT_ID. " +
      "Ответ вернёт числовой chatId — передавай его в bitrix_chat_history / bitrix_chat_mark_read. " +
      "messageLimit по умолчанию 25.",
    mutating: false,
    input: { chatId: anyId().optional(), dialogId: anyId().optional(), messageLimit: z.number().optional(), params },
    run: (ctx, a) =>
      send(ctx, CHAT_LOAD, {
        ...(a.chatId !== undefined ? { chatId: a.chatId } : {}),
        ...(a.dialogId !== undefined ? { dialogId: a.dialogId } : {}),
        ...(a.messageLimit !== undefined ? { messageLimit: a.messageLimit } : {}),
      }, a.params),
  }),
  defineOperation({
    name: "chat_history",
    description:
      "Листать историю чата ВГЛУБЬ (старые сообщения). beforeId — минимальный id сообщения из текущей " +
      "страницы; повторяй, уменьшая beforeId, до начала истории. limit по умолчанию 25, порядок — DESC.",
    mutating: false,
    input: { chatId: anyId(), beforeId: anyId().optional(), limit: z.number().optional(), params },
    run: (ctx, a) =>
      send(ctx, CHAT_MESSAGES_TAIL, {
        chatId: a.chatId,
        ...(a.beforeId !== undefined ? { "filter[lastId]": a.beforeId } : {}),
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
      }, a.params),
  }),
  defineOperation({
    name: "chat_mark_read",
    description:
      "⚠ МУТИРУЮЩИЙ. Пометить сообщения чата прочитанными. ids — массив id сообщений; " +
      "actionUuid генерируется автоматически, если не передан.",
    mutating: true,
    input: { chatId: anyId(), ids: z.array(anyId()).min(1), actionUuid: z.string().optional(), params },
    run: (ctx, a) =>
      send(ctx, CHAT_MESSAGE_READ, { chatId: a.chatId, ids: a.ids, actionUuid: a.actionUuid ?? randomUUID() }, a.params),
  }),
  defineOperation({
    name: "entity_selector",
    description:
      "Поиск/резолв сущностей (пользователи, проекты, чаты) через entityselector (JSON API). " +
      'Найти ЧАТ/диалог: dialog={id:"im-chat-search",context:"IM_CHAT_SEARCH",' +
      'entities:[{id:"im-recent-v2",dynamicLoad:true,dynamicSearch:true}]}. ' +
      'Найти ПОЛЬЗОВАТЕЛЯ: entities:[{id:"user"}]. Свободный текстовый запрос сверь реверсом.',
    mutating: false,
    input: { dialog: z.record(z.unknown()), params },
    run: (ctx, a) => send(ctx, ENTITYSELECTOR_LOAD, { dialog: a.dialog }, a.params),
  }),
  defineOperation({
    name: "recent_load",
    description:
      "Недавние чаты по СЕКЦИИ (im.v2). section: \"tasksTask\" — ЧАТЫ ЗАДАЧ (обсуждения задач; в " +
      "bitrix_chats_recent их нет), \"collab\"/\"collabDefault\" — коллабы, иначе обычные диалоги. " +
      "Отдаёт chatId/dialogId — дальше открывай bitrix_chat_load. Листать глубже — bitrix_recent_tail.",
    mutating: false,
    input: {
      section: z.string().optional(),
      limit: z.number().optional(),
      unread: z.boolean().optional(),
      parentId: anyId().optional(),
      params,
    },
    run: (ctx, a) =>
      send(ctx, RECENT_LOAD, {
        limit: a.limit ?? 50,
        ...(a.section !== undefined ? { "filter[recentSection]": a.section } : {}),
        ...(a.parentId !== undefined ? { "filter[parentId]": a.parentId } : {}),
        "filter[unread]": a.unread ? "Y" : "N",
      }, a.params),
  }),
  defineOperation({
    name: "recent_tail",
    description:
      "Листать недавние ВГЛУБЬ (im.v2). lastMessageDate — ISO-дата последнего элемента текущей " +
      "страницы (курсор); section — как в bitrix_recent_load. Повторяй, сдвигая lastMessageDate.",
    mutating: false,
    input: {
      lastMessageDate: z.string(),
      section: z.string().optional(),
      limit: z.number().optional(),
      unread: z.boolean().optional(),
      params,
    },
    run: (ctx, a) =>
      send(ctx, RECENT_TAIL, {
        limit: a.limit ?? 50,
        "filter[lastMessageDate]": a.lastMessageDate,
        ...(a.section !== undefined ? { "filter[recentSection]": a.section } : {}),
        "filter[unread]": a.unread ? "Y" : "N",
      }, a.params),
  }),
  defineOperation({
    name: "entity_search",
    description:
      "ТЕКСТОВЫЙ поиск чатов/диалогов по строке (entityselector, JSON API) — ГЛАВНЫЙ способ найти " +
      "чат по названию или человека по ИМЕНИ. query — строка поиска. Поиск по имени человека вернёт " +
      "ЛИЧНЫЙ диалог с ним — его dialogId (= userId); открывай bitrix_chat_load { dialogId }. " +
      "section: \"tasksTask\" — среди чатов задач, \"default\" (умолч.) — среди всех диалогов. " +
      "Для иных сущностей передай свой dialog целиком.",
    mutating: false,
    input: { query: z.string(), section: z.string().optional(), dialog: z.record(z.unknown()).optional(), params },
    run: (ctx, a) =>
      send(ctx, ENTITYSELECTOR_SEARCH, {
        dialog: a.dialog ?? {
          id: "im-chat-search",
          context: "IM_CHAT_SEARCH",
          entities: [{ id: "im-recent-v2", dynamicLoad: true, dynamicSearch: true, options: { searchRecentSection: a.section ?? "default", parentId: 0 } }],
          preselectedItems: [],
          clearUnavailableItems: false,
        },
        searchQuery: { query: a.query, queryWords: [a.query] },
      }, a.params),
  }),
  defineOperation({
    name: "chat_get_dialog_id",
    description:
      "Резолв dialogId чата по externalId (im.v2). Напр. externalId \"sg\"+<groupId> → dialogId " +
      "чата соцгруппы/проекта. Затем открывай через bitrix_chat_load.",
    mutating: false,
    input: { externalId: z.string(), params },
    run: (ctx, a) => send(ctx, CHAT_DIALOG_ID, { externalId: a.externalId }, a.params),
  }),
  defineOperation({
    name: "chat_read_all",
    description: "⚠ МУТИРУЮЩИЙ. Пометить ВСЕ чаты прочитанными (im.v2). Параметров нет.",
    mutating: true,
    input: { params },
    run: (ctx, a) => send(ctx, CHAT_READ_ALL, {}, a.params),
  }),
  defineOperation({
    name: "task_subtasks",
    description: "Подзадачи задачи (v2 relations, JSON API). taskId — id родителя. navigation.size управляет страницей.",
    mutating: false,
    input: { taskId: anyId(), params },
    run: (ctx, a) =>
      send(ctx, TASK_SUBTASKS, { taskId: a.taskId, withIds: true, withCompleted: true, withSubTasks: true, navigation: { size: 10 } }, a.params),
  }),
  defineOperation({
    name: "task_related",
    description: "Связанные задачи (v2 relations, JSON API). taskId — id задачи.",
    mutating: false,
    input: { taskId: anyId(), params },
    run: (ctx, a) =>
      send(ctx, TASK_RELATED, { taskId: a.taskId, withIds: true, withCompleted: true, withSubTasks: true, navigation: { size: 10 } }, a.params),
  }),
  defineOperation({
    name: "user_get",
    description: "Карточка пользователя мессенджера по id (имя, аватар, статус). userId — id пользователя.",
    mutating: false,
    input: { userId: anyId(), params },
    run: (ctx, a) => send(ctx, IM_USER_GET, { ID: a.userId }, a.params),
  }),
  defineOperation({
    name: "entity_chat",
    description:
      "Резолв chatId чата, ПРИВЯЗАННОГО к объекту (im.chat.get). entityType/entityId — тип и id " +
      'объекта: "TASKS_TASK" (чат-обсуждение задачи), "SONET_GROUP" (чат группы/проекта), "CRM", ' +
      '"CALENDAR", "MAIL", "VIDEOCONF", "LINES", "CALL". Даёт прямой «объект → chatId» без поиска по ' +
      "названию. Для задачи проще всё же CHAT_ID из bitrix_task_get; этот инструмент — общий, на любую " +
      "сущность. Полученный chatId открывай bitrix_chat_load { chatId }.",
    mutating: false,
    input: { entityType: z.string(), entityId: anyId(), params },
    run: (ctx, a) => send(ctx, IM_CHAT_GET, { ENTITY_TYPE: a.entityType, ENTITY_ID: a.entityId }, a.params),
  }),
];
