import { describe, it, expect, mock } from "bun:test";
import type { CallTarget, DownloadResult } from "../../shared/wire.js";
import type { OpContext, Operation } from "./operation.js";
import { OPERATIONS } from "./index.js";

const AJAX = "/bitrix/services/main/ajax.php";

function fakeCtx(result: unknown = { ok: true }) {
  const call = mock(async (_target: CallTarget): Promise<unknown> => result);
  const callBinary = mock(async (_target: CallTarget, _dest: string): Promise<DownloadResult> => {
    throw new Error("unexpected download");
  });
  const ctx: OpContext = { portal: "d", origin: "https://d.bitrix24.ru", downloadsDir: "/tmp/br24-unused", call, callBinary };
  return { ctx, call, callBinary };
}

function op(name: string): Operation {
  const found = OPERATIONS.find((o) => o.name === name);
  if (!found) throw new Error(`no operation ${name}`);
  return found;
}

const form = { endpoint: AJAX, method: "POST", bodyType: "form", responseType: "json" } as const;
const json = { endpoint: AJAX, method: "POST", bodyType: "json", responseType: "json" } as const;
const rest = (endpoint: string) => ({ endpoint, action: null, method: "POST", bodyType: "form", responseType: "json" }) as const;

const TASK_LIST_SELECT = ["ID", "TITLE", "STATUS", "RESPONSIBLE_ID", "CREATED_BY", "DEADLINE", "GROUP_ID", "PRIORITY"];
const TASK_GET_SELECT = ["ID", "TITLE", "DESCRIPTION", "STATUS", "RESPONSIBLE_ID", "CREATED_BY", "CREATED_DATE", "DEADLINE", "PRIORITY", "GROUP_ID", "CLOSED_DATE", "CHAT_ID"];
const GROUP_LIST_SELECT = ["ID", "NAME", "DESCRIPTION", "NUMBER_OF_MEMBERS", "OWNER_ID", "DATE_CREATE", "PROJECT"];
const GROUP_GET_SELECT = ["ID", "NAME", "DESCRIPTION", "OWNER_DATA", "SUBJECT_DATA", "NUMBER_OF_MEMBERS", "DATE_CREATE"];
const RELATIONS = { withIds: true, withCompleted: true, withSubTasks: true };

describe("OPERATIONS", () => {
  it("holds exactly the bridge's operations", () => {
    expect(OPERATIONS.map((o) => o.name).sort()).toEqual([
      "tasks_list", "task_get", "task_get_v2", "task_scrum_info", "task_files", "task_views_count",
      "task_subtasks", "task_related", "task_comments", "projects_list", "project_get", "chats_recent",
      "chat_load", "chat_messages", "chat_history", "chat_mark_read", "chat_read_all", "chat_get_dialog_id",
      "chat_calls", "recent_load", "recent_tail", "entity_selector", "entity_search", "entity_chat",
      "user_get", "call_detail", "call_recording", "file_download",
    ].sort());
  });

  it("marks only chat_mark_read and chat_read_all as mutating", () => {
    expect(OPERATIONS.filter((o) => o.mutating).map((o) => o.name).sort()).toEqual(["chat_mark_read", "chat_read_all"]);
  });
});

const cases: Array<{ name: string; title: string; args: Record<string, unknown>; target: CallTarget }> = [
  {
    name: "tasks_list",
    title: "keeps STATUS in the default select, forwards PAGEN_1 and lets agent params override the order",
    args: { params: { filter: { REAL_STATUS: 2 }, order: { ID: "asc" }, PAGEN_1: 2 } },
    target: { ...form, action: "tasks.task.list", params: { select: TASK_LIST_SELECT, order: { ID: "asc" }, filter: { REAL_STATUS: 2 }, PAGEN_1: 2 } },
  },
  {
    name: "tasks_list",
    title: "lets the agent replace the default select",
    args: { params: { select: ["ID"], order: { DEADLINE: "asc" } } },
    target: { ...form, action: "tasks.task.list", params: { select: ["ID"], order: { DEADLINE: "asc" } } },
  },
  {
    name: "task_get",
    title: "sends taskId with the default select",
    args: { taskId: 42 },
    target: { ...form, action: "tasks.task.get", params: { taskId: 42, select: TASK_GET_SELECT } },
  },
  {
    name: "task_get_v2",
    title: "wraps the id as { task: { id } } in a json body",
    args: { taskId: 4229 },
    target: { ...json, action: "tasks.v2.Task.get", params: { task: { id: 4229 } } },
  },
  {
    name: "task_scrum_info",
    title: "sends a flat taskId in a json body",
    args: { taskId: 7 },
    target: { ...json, action: "tasks.v2.Scrum.getTaskInfo", params: { taskId: 7 } },
  },
  {
    name: "task_files",
    title: "sends the attached-object ids",
    args: { ids: [21005, "18497"] },
    target: { ...json, action: "tasks.v2.File.listObjects", params: { ids: [21005, "18497"] } },
  },
  {
    name: "task_views_count",
    title: "wraps the id as { task: { id } }",
    args: { taskId: 7 },
    target: { ...json, action: "tasks.v2.Task.View.User.count", params: { task: { id: 7 } } },
  },
  {
    name: "task_subtasks",
    title: "sends relation flags and lets the agent widen navigation",
    args: { taskId: 29273, params: { navigation: { size: 100 } } },
    target: { ...json, action: "tasks.v2.Task.Relation.Child.list", params: { taskId: 29273, ...RELATIONS, navigation: { size: 100 } } },
  },
  {
    name: "task_related",
    title: "sends relation flags with a 10-item page",
    args: { taskId: 5 },
    target: { ...json, action: "tasks.v2.Task.Relation.Related.list", params: { taskId: 5, ...RELATIONS, navigation: { size: 10 } } },
  },
  {
    name: "projects_list",
    title: "sends the default select ordered by name",
    args: {},
    target: { ...form, action: "socialnetwork.api.workgroup.list", params: { select: GROUP_LIST_SELECT, order: { NAME: "asc" } } },
  },
  {
    name: "project_get",
    title: "wraps its arguments under params[...]",
    args: { groupId: 12 },
    target: { ...form, action: "socialnetwork.api.workgroup.get", params: { params: { groupId: 12, select: GROUP_GET_SELECT } } },
  },
  {
    name: "chats_recent",
    title: "keeps the REST defaults and merges agent filters",
    args: { params: { UNREAD_ONLY: "Y" } },
    target: {
      ...rest("/rest/im.recent.list.json"),
      params: { LIMIT: 50, SKIP_OPENLINES: "Y", GET_ORIGINAL_TEXT: "Y", PARSE_TEXT: "Y", WITH_COUNTERS: "N", UNREAD_ONLY: "Y" },
    },
  },
  {
    name: "chat_load",
    title: "addresses a private chat by dialogId with the default message limit",
    args: { dialogId: 11 },
    target: { ...form, action: "im.v2.Chat.load", params: { messageLimit: 25, dialogId: 11 } },
  },
  {
    name: "chat_load",
    title: "addresses a group chat by chatId and honours messageLimit",
    args: { chatId: 485, messageLimit: 5 },
    target: { ...form, action: "im.v2.Chat.load", params: { messageLimit: 5, chatId: 485 } },
  },
  {
    // im.v2.Chat.Message.list returns only the latest page — beforeId is not part of the input,
    // so no filter[lastId] leaks through (deep paging lives in chat_history).
    name: "chat_messages",
    title: "defaults limit to 20 and does not page backward",
    args: { chatId: "485", beforeId: 84869 },
    target: { ...form, action: "im.v2.Chat.Message.list", params: { chatId: "485", limit: 20 } },
  },
  {
    name: "chat_history",
    title: "maps beforeId to filter[lastId] and keeps the DESC default",
    args: { chatId: 485, beforeId: 1861279 },
    target: { ...form, action: "im.v2.Chat.Message.tail", params: { "order[id]": "DESC", limit: 25, chatId: 485, "filter[lastId]": 1861279 } },
  },
  {
    name: "chat_mark_read",
    title: "passes an explicit actionUuid through",
    args: { chatId: 40271, ids: [1884131], actionUuid: "fixed-uuid" },
    target: { ...form, action: "im.v2.Chat.Message.read", params: { chatId: 40271, ids: [1884131], actionUuid: "fixed-uuid" } },
  },
  {
    name: "chat_read_all",
    title: "sends an empty body",
    args: {},
    target: { ...form, action: "im.v2.Chat.readAll", params: {} },
  },
  {
    name: "chat_get_dialog_id",
    title: "sends the externalId",
    args: { externalId: "sg12" },
    target: { ...form, action: "im.v2.Chat.getDialogId", params: { externalId: "sg12" } },
  },
  {
    name: "recent_load",
    title: "maps section to filter[recentSection] with unread=N by default",
    args: { section: "tasksTask" },
    target: { ...form, action: "im.v2.Recent.load", params: { limit: 50, "filter[recentSection]": "tasksTask", "filter[unread]": "N" } },
  },
  {
    name: "recent_tail",
    title: "pages by lastMessageDate and maps unread to Y",
    args: { lastMessageDate: "2026-10-01T10:00:00+03:00", unread: true },
    target: {
      ...form,
      action: "im.v2.Recent.tail",
      params: { limit: 50, "filter[lastMessageDate]": "2026-10-01T10:00:00+03:00", "filter[unread]": "Y" },
    },
  },
  {
    name: "entity_selector",
    title: "sends the caller's dialog",
    args: { dialog: { id: "user-search", entities: [{ id: "user" }] } },
    target: { ...json, action: "ui.entityselector.load", params: { dialog: { id: "user-search", entities: [{ id: "user" }] } } },
  },
  {
    name: "entity_search",
    title: "builds an IM_CHAT_SEARCH dialog and searchQuery from query",
    args: { query: "дмитрий", section: "tasksTask" },
    target: {
      ...json,
      action: "ui.entityselector.doSearch",
      params: {
        dialog: {
          id: "im-chat-search",
          context: "IM_CHAT_SEARCH",
          entities: [{ id: "im-recent-v2", dynamicLoad: true, dynamicSearch: true, options: { searchRecentSection: "tasksTask", parentId: 0 } }],
          preselectedItems: [],
          clearUnavailableItems: false,
        },
        searchQuery: { query: "дмитрий", queryWords: ["дмитрий"] },
      },
    },
  },
  {
    name: "entity_chat",
    title: "maps entityType/entityId to ENTITY_TYPE/ENTITY_ID",
    args: { entityType: "TASKS_TASK", entityId: 28373 },
    target: { ...rest("/rest/im.chat.get.json"), params: { ENTITY_TYPE: "TASKS_TASK", ENTITY_ID: 28373 } },
  },
  {
    name: "user_get",
    title: "maps userId to ID",
    args: { userId: 11 },
    target: { ...rest("/rest/im.user.get.json"), params: { ID: 11 } },
  },
];

describe("read operations", () => {
  for (const c of cases) {
    it(`${c.name} ${c.title}`, async () => {
      const { ctx, call } = fakeCtx({ answer: c.name });

      const result = await op(c.name).execute(ctx, c.args);

      expect(call).toHaveBeenCalledTimes(1);
      expect(call.mock.calls[0][0]).toEqual(c.target);
      expect(result).toEqual({ answer: c.name }); // the portal's reply comes back untouched
    });
  }

  it("chat_mark_read generates an actionUuid when none is given", async () => {
    const { ctx, call } = fakeCtx();

    await op("chat_mark_read").execute(ctx, { chatId: 40271, ids: [1884131] });

    const params = call.mock.calls[0][0].params;
    expect(params.chatId).toBe(40271);
    expect(params.ids).toEqual([1884131]);
    expect(typeof params.actionUuid).toBe("string");
    expect(String(params.actionUuid).length).toBeGreaterThan(10);
  });

  it("task_files explains that ids are attached-object ids and downloadUrl is relative", () => {
    const description = op("task_files").description;
    expect(description).toContain("UF_TASK_WEBDAV_FILES");
    expect(description).toContain("downloadUrl");
  });
});
