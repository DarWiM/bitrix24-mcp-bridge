import { describe, it, expect, mock, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "./register.js";
import type { Catalog } from "../catalog/catalog.js";

function fakeServer() {
  const handlers: Record<string, Function> = {};
  const server = { registerTool: (n: string, _s: unknown, h: Function) => { handlers[n] = h; }, registerResource: () => {} };
  return { server: server as any, handlers };
}

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "br24-tools-"));
  tempDirs.push(dir);
  return dir;
}

const catalog: Catalog = {
  resolve: (name) => {
    if (name === "tasks.list")
      return { endpoint: "/bitrix/services/main/ajax.php", action: "tasks.task.list", method: "POST", params: { FILTER: {} }, bodyType: "form", responseType: "json" };
    throw new Error(`call "${name}" is not allowed`);
  },
  names: () => ["tasks.list"],
};

describe("bitrix_call", () => {
  it("resolves name via catalog and forwards a merged CallTarget to sink", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ tasks: [] });
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog, defaultPortal: "default", portals: ["default"] });

    const res = await handlers["bitrix_call"]({ name: "tasks.list", params: { PAGE: 1 } });

    expect(call).toHaveBeenCalledWith("default", {
      endpoint: "/bitrix/services/main/ajax.php",
      action: "tasks.task.list",
      method: "POST",
      params: { FILTER: {}, PAGE: 1 },
      bodyType: "form",
      responseType: "json",
    });
    expect(res.content[0].text).toContain("tasks");
  });

  it("forwards an explicit portal instead of the default", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ tasks: [] });
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog, defaultPortal: "default", portals: ["default", "other"] });

    await handlers["bitrix_call"]({ name: "tasks.list", portal: "other" });

    expect(call).toHaveBeenCalledWith("other", expect.objectContaining({ action: "tasks.task.list" }));
  });

  it("returns an error result for a disallowed name", async () => {
    const { server, handlers } = fakeServer();
    const call = mock();
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog, defaultPortal: "default", portals: ["default"] });
    const res = await handlers["bitrix_call"]({ name: "crm.deal.list" });
    expect(res.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("bitrix_status tool", () => {
  it("reports the default portal and each portal's connection state", async () => {
    const { server, handlers } = fakeServer();
    const sink = {
      call: mock(),
      status: async () => ({ portals: [{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: true }] }),
    };
    registerTools(server, { sink, catalog, defaultPortal: "acme", portals: ["acme"] });

    const handler = handlers["bitrix_status"];
    expect(handler).toBeDefined();
    const res = await handler({});
    const payload = JSON.parse(res.content[0].text);
    expect(payload).toMatchObject({
      configured: true,
      defaultPortal: "acme",
      portals: [{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: true }],
    });
  });

  it("warns when the connected extension is older than the bridge", async () => {
    const { server, handlers } = fakeServer();
    const sink = {
      call: mock(),
      status: async () => ({ portals: [{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: true, extensionVersion: "0.2.1" }] }),
    };
    registerTools(server, { sink, catalog, defaultPortal: "acme", portals: ["acme"] });

    const payload = JSON.parse((await handlers["bitrix_status"]({})).content[0].text);

    expect(payload.warning).toMatch(/устарело/);
    expect(payload.warning).toContain("0.2.1");
    expect(payload.warning).toContain("chrome://extensions");
  });

  it("does not warn about a portal that is not connected", async () => {
    const { server, handlers } = fakeServer();
    const sink = {
      call: mock(),
      status: async () => ({ portals: [{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: false, extensionVersion: null }] }),
    };
    registerTools(server, { sink, catalog, defaultPortal: "acme", portals: ["acme"] });

    const payload = JSON.parse((await handlers["bitrix_status"]({})).content[0].text);

    expect(payload.warning).toBeUndefined();
  });
});

const AJAX = "/bitrix/services/main/ajax.php";
const richEntries: Record<string, { endpoint: string; action: string | null; bodyType: "json" | "form"; params?: Record<string, unknown> }> = {
  "tasks.list": { endpoint: AJAX, action: "tasks.task.list", bodyType: "form" },
  "task.v2.get": { endpoint: AJAX, action: "tasks.v2.Task.get", bodyType: "json" },
  "chat.load": { endpoint: AJAX, action: "im.v2.Chat.load", bodyType: "form", params: { messageLimit: 25 } },
  "chat.messages.tail": { endpoint: AJAX, action: "im.v2.Chat.Message.tail", bodyType: "form", params: { "order[id]": "DESC", limit: 25 } },
  "chat.message.read": { endpoint: AJAX, action: "im.v2.Chat.Message.read", bodyType: "form" },
  "recent.load": { endpoint: AJAX, action: "im.v2.Recent.load", bodyType: "form" },
  "entityselector.search": { endpoint: AJAX, action: "ui.entityselector.doSearch", bodyType: "json" },
  "chat.read.all": { endpoint: AJAX, action: "im.v2.Chat.readAll", bodyType: "form" },
  "task.subtasks": { endpoint: AJAX, action: "tasks.v2.Task.Relation.Child.list", bodyType: "json" },
  "im.user.get": { endpoint: "/rest/im.user.get.json", action: null, bodyType: "form" },
  "im.chat.get": { endpoint: "/rest/im.chat.get.json", action: null, bodyType: "form" },
};
const richCatalog: Catalog = {
  resolve: (name) => {
    const e = richEntries[name];
    if (!e) throw new Error(`call "${name}" is not allowed`);
    return { endpoint: e.endpoint, action: e.action, method: "POST", params: e.params ?? {}, bodyType: e.bodyType, responseType: "json" };
  },
  names: () => Object.keys(richEntries),
};

describe("typed tools — json / pagination / write", () => {
  // Paging this ajax action is PAGEN_1 (page number), not the REST-style `start` offset:
  // `start` silently returns the first page again, so the page number must survive the merge.
  it("bitrix_tasks_list keeps STATUS in the default select and forwards PAGEN_1", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_tasks_list"]({ params: { filter: { RESPONSIBLE_ID: 55 }, PAGEN_1: 2 } });

    const target = call.mock.calls[0][1];
    expect(target.params.select).toContain("STATUS");
    expect(target.params).toMatchObject({ order: { ID: "desc" }, filter: { RESPONSIBLE_ID: 55 }, PAGEN_1: 2 });
  });

  it("bitrix_tasks_list lets caller params override the wrapper defaults", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_tasks_list"]({ params: { select: ["ID"], order: { DEADLINE: "asc" } } });

    expect(call.mock.calls[0][1].params).toMatchObject({ select: ["ID"], order: { DEADLINE: "asc" } });
  });

  it("bitrix_task_get_v2 forwards json bodyType with { task }", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_task_get_v2"]({ taskId: 4229 });

    expect(call).toHaveBeenCalledWith("d", expect.objectContaining({
      action: "tasks.v2.Task.get",
      bodyType: "json",
      params: expect.objectContaining({ task: { id: 4229 } }), // v2 wraps the id
    }));
  });

  it("bitrix_recent_load maps section -> filter[recentSection] with unread=N default", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_recent_load"]({ section: "tasksTask" });

    const target = call.mock.calls[0][1];
    expect(target.params).toMatchObject({ limit: 50, "filter[recentSection]": "tasksTask", "filter[unread]": "N" });
  });

  it("bitrix_entity_search builds an IM_CHAT_SEARCH dialog + searchQuery from query", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_entity_search"]({ query: "дмитрий", section: "tasksTask" });

    const target = call.mock.calls[0][1];
    expect(target.bodyType).toBe("json");
    expect(target.params.searchQuery).toEqual({ query: "дмитрий", queryWords: ["дмитрий"] });
    expect((target.params.dialog as any).context).toBe("IM_CHAT_SEARCH");
    expect((target.params.dialog as any).entities[0].options.searchRecentSection).toBe("tasksTask");
  });

  it("bitrix_chat_read_all sends an empty body (mutating, no params)", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_chat_read_all"]({});

    expect(call.mock.calls[0][1].params).toEqual({});
  });

  it("bitrix_user_get maps userId -> ID for the im.user.get REST call", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_user_get"]({ userId: 11 });

    const target = call.mock.calls[0][1];
    expect(target.endpoint).toBe("/rest/im.user.get.json");
    expect(target.params).toMatchObject({ ID: 11 });
  });

  it("bitrix_entity_chat maps entityType/entityId -> ENTITY_TYPE/ENTITY_ID for im.chat.get", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_entity_chat"]({ entityType: "TASKS_TASK", entityId: 28373 });

    const target = call.mock.calls[0][1];
    expect(target.endpoint).toBe("/rest/im.chat.get.json");
    expect(target.params).toMatchObject({ ENTITY_TYPE: "TASKS_TASK", ENTITY_ID: 28373 });
  });

  it("bitrix_chat_load addresses a private chat by dialogId (user id)", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_chat_load"]({ dialogId: 11 });

    const target = call.mock.calls[0][1];
    expect(target.params).toMatchObject({ dialogId: 11, messageLimit: 25 });
    expect(target.params.chatId).toBeUndefined();
  });

  it("bitrix_chat_history maps beforeId -> filter[lastId] and keeps the DESC default", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_chat_history"]({ chatId: 485, beforeId: 1861279 });

    const target = call.mock.calls[0][1];
    expect(target.params).toMatchObject({ chatId: 485, "filter[lastId]": 1861279, "order[id]": "DESC", limit: 25 });
  });

  it("bitrix_chat_mark_read auto-generates actionUuid when omitted", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({});
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: richCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_chat_mark_read"]({ chatId: 40271, ids: [1884131] });

    const target = call.mock.calls[0][1];
    expect(target.params.chatId).toBe(40271);
    expect(target.params.ids).toEqual([1884131]);
    expect(typeof target.params.actionUuid).toBe("string");
    expect(target.params.actionUuid.length).toBeGreaterThan(10);
  });
});

const callCatalog: Catalog = {
  resolve: (name) => {
    if (name === "call.detail")
      return { endpoint: "/call/detail/{callId}", action: null, method: "GET", params: { IFRAME: "Y", IFRAME_TYPE: "SIDE_SLIDER" }, bodyType: "form", responseType: "text" };
    if (name === "chat.messages.tail")
      return { endpoint: AJAX, action: "im.v2.Chat.Message.tail", method: "POST", params: { "order[id]": "DESC", limit: 25 }, bodyType: "form", responseType: "json" };
    throw new Error(`call "${name}" is not allowed`);
  },
  names: () => ["call.detail", "chat.messages.tail"],
};

function pageWithTranscript(lines: number): string {
  const P = "bx-call-component-call-ai";
  const blocks = Array.from({ length: lines }, (_, i) =>
    `<div class="${P}-decryption-block"><p class="${P}-decryption-block__description">` +
    `<span class="${P}-decryption-block__time">00:${String(i % 60).padStart(2, "0")}—00:${String((i % 60) + 1).padStart(2, "0")}</span>` +
    `<span class="${P}-decryption-block__name">Пётр:</span> Реплика номер ${i} с достаточным количеством текста для набора объёма.</p></div>`,
  ).join("");
  return `<div data-call-id="4242"><h3 class="${P}__resume-title">Синк</h3>` +
    `<div id="TabTranscriptions" class="${P}__tab-details --transcriptions">${blocks}</div></div>`;
}

const callPage = '<div data-call-id="4242"><h3 class="bx-call-component-call-ai__resume-title">Синк</h3></div>';

function callMessage(id: number, callId: number, messageType: string) {
  return { id, authorId: 101, date: "2026-07-23T12:46:33+03:00", params: { COMPONENT_ID: "CallMessage", COMPONENT_PARAMS: { messageType, callId } } };
}

describe("call tools", () => {
  it("bitrix_call_detail sends callId for the path template and parses the returned HTML", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ contentType: "text/html", text: callPage });
    registerTools(server, {
      sink: { call, status: async () => ({ portals: [] }) },
      catalog: callCatalog,
      defaultPortal: "d",
      portals: ["d"],
      origins: { d: "https://d.bitrix24.ru" },
    });

    const res = await handlers["bitrix_call_detail"]({ callId: 4242 });

    expect(call).toHaveBeenCalledWith("d", expect.objectContaining({
      endpoint: "/call/detail/{callId}",
      method: "GET",
      responseType: "text",
      params: { IFRAME: "Y", IFRAME_TYPE: "SIDE_SLIDER", callId: 4242 },
    }));
    expect(JSON.parse(res.content[0].text)).toMatchObject({ id: 4242, title: "Синк" });
  });

  it("bitrix_call_detail keeps a short transcript inline", async () => {
    const { server, handlers } = fakeServer();
    const dir = tempDir();
    const call = mock().mockResolvedValue({ contentType: "text/html", text: pageWithTranscript(3) });
    registerTools(server, {
      sink: { call, status: async () => ({ portals: [] }) },
      catalog: callCatalog,
      defaultPortal: "d",
      portals: ["d"],
      origins: { d: "https://d.bitrix24.ru" },
      downloadsDir: dir,
    });

    const payload = JSON.parse((await handlers["bitrix_call_detail"]({ callId: 4242 })).content[0].text);

    expect(payload.transcript).toHaveLength(3);
    expect(payload.files).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("bitrix_call_detail spills a long transcript to disk and returns the paths", async () => {
    const { server, handlers } = fakeServer();
    const dir = tempDir();
    const call = mock().mockResolvedValue({ contentType: "text/html", text: pageWithTranscript(400) });
    registerTools(server, {
      sink: { call, status: async () => ({ portals: [] }) },
      catalog: callCatalog,
      defaultPortal: "d",
      portals: ["d"],
      origins: { d: "https://d.bitrix24.ru" },
      downloadsDir: dir,
    });

    const payload = JSON.parse((await handlers["bitrix_call_detail"]({ callId: 4242 })).content[0].text);

    expect(payload.transcript).toEqual([]);
    expect(payload.transcriptCount).toBe(400);
    expect(payload.files.transcript).toBe(join(dir, "call-4242-transcript.txt"));
    expect(payload.files.json).toBe(join(dir, "call-4242.json"));
    const text = readFileSync(payload.files.transcript, "utf8");
    expect(text).toContain("Звонок №4242");
    expect(text.split("\n").filter((l: string) => l.startsWith("[")).length).toBe(400);
    // the archived JSON keeps what the reply dropped
    expect(JSON.parse(readFileSync(payload.files.json, "utf8")).transcript).toHaveLength(400);
  });

  it("bitrix_call_detail forces a file when asked, even for a short transcript", async () => {
    const { server, handlers } = fakeServer();
    const dir = tempDir();
    const call = mock().mockResolvedValue({ contentType: "text/html", text: pageWithTranscript(2) });
    registerTools(server, {
      sink: { call, status: async () => ({ portals: [] }) },
      catalog: callCatalog,
      defaultPortal: "d",
      portals: ["d"],
      origins: { d: "https://d.bitrix24.ru" },
      downloadsDir: dir,
    });

    const payload = JSON.parse((await handlers["bitrix_call_detail"]({ callId: 4242, transcript: "file" })).content[0].text);

    expect(payload.transcript).toEqual([]);
    expect(existsSync(payload.files.transcript)).toBe(true);
  });

  it("bitrix_call_detail returns a long transcript inline when explicitly asked", async () => {
    const { server, handlers } = fakeServer();
    const dir = tempDir();
    const call = mock().mockResolvedValue({ contentType: "text/html", text: pageWithTranscript(400) });
    registerTools(server, {
      sink: { call, status: async () => ({ portals: [] }) },
      catalog: callCatalog,
      defaultPortal: "d",
      portals: ["d"],
      origins: { d: "https://d.bitrix24.ru" },
      downloadsDir: dir,
    });

    const payload = JSON.parse((await handlers["bitrix_call_detail"]({ callId: 4242, transcript: "inline" })).content[0].text);

    expect(payload.transcript).toHaveLength(400);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("bitrix_call_detail drops the transcript entirely for transcript:none", async () => {
    const { server, handlers } = fakeServer();
    const dir = tempDir();
    const call = mock().mockResolvedValue({ contentType: "text/html", text: pageWithTranscript(400) });
    registerTools(server, {
      sink: { call, status: async () => ({ portals: [] }) },
      catalog: callCatalog,
      defaultPortal: "d",
      portals: ["d"],
      origins: { d: "https://d.bitrix24.ru" },
      downloadsDir: dir,
    });

    const payload = JSON.parse((await handlers["bitrix_call_detail"]({ callId: 4242, transcript: "none" })).content[0].text);

    expect(payload.transcript).toEqual([]);
    expect(payload.files).toBeUndefined();
    expect(payload.transcriptCount).toBe(400); // size still reported
    expect(readdirSync(dir)).toEqual([]);
  });

  it("bitrix_call_detail surfaces a non-text response as an error instead of crashing", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ status: "success", data: {} });
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: callCatalog, defaultPortal: "d", portals: ["d"] });

    const res = await handlers["bitrix_call_detail"]({ callId: 4242 });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("responseType");
  });

  it("bitrix_chat_calls pages back with filter[lastId] until the history ends", async () => {
    const { server, handlers } = fakeServer();
    const call = mock()
      .mockResolvedValueOnce({ data: { messages: [callMessage(5002, 4243, "START")], hasNextPage: true } })
      .mockResolvedValueOnce({ data: { messages: [callMessage(5001, 4242, "START")], hasNextPage: false } });
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: callCatalog, defaultPortal: "d", portals: ["d"] });

    const res = await handlers["bitrix_chat_calls"]({ chatId: 999 });
    const payload = JSON.parse(res.content[0].text);

    expect(call.mock.calls[0][1].params).toMatchObject({ chatId: 999, limit: 50 });
    expect(call.mock.calls[0][1].params["filter[lastId]"]).toBeUndefined();
    expect(call.mock.calls[1][1].params["filter[lastId]"]).toBe(5002); // cursor = oldest id of page 1
    expect(payload.calls.map((c: { callId: number }) => c.callId)).toEqual([4243, 4242]);
    expect(payload.reachedHistoryStart).toBe(true);
    expect(payload.scannedPages).toBe(2);
  });

  it("bitrix_chat_calls reports an unfinished scan so the agent can continue", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ data: { messages: [callMessage(5002, 4243, "START")], hasNextPage: true } });
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: callCatalog, defaultPortal: "d", portals: ["d"] });

    const res = await handlers["bitrix_chat_calls"]({ chatId: 999, maxPages: 2, limit: 50 });
    const payload = JSON.parse(res.content[0].text);

    expect(payload.reachedHistoryStart).toBe(false);
    expect(payload.oldestScannedMessageId).toBe(5002);
    expect(payload.scannedPages).toBe(2);
  });

  it("bitrix_chat_calls starts from beforeId when continuing a previous scan", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ data: { messages: [], hasNextPage: false } });
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog: callCatalog, defaultPortal: "d", portals: ["d"] });

    await handlers["bitrix_chat_calls"]({ chatId: 999, beforeId: 4999 });

    expect(call.mock.calls[0][1].params["filter[lastId]"]).toBe(4999);
  });
});

const NAVIGATE_ENDPOINT = "/bitrix/services/main/ajax.php?mode=class&c=bitrix%3Aforum.comments&action=navigateComment";

const commentsCatalog: Catalog = {
  resolve: (name) => {
    if (name === "task.comments.page")
      return { endpoint: "/task/comments/{taskId}/", action: null, method: "GET", params: { IFRAME: "Y", IFRAME_TYPE: "SIDE_SLIDER" }, bodyType: "form", responseType: "text" };
    if (name === "task.comments.navigate")
      return { endpoint: NAVIGATE_ENDPOINT, action: null, method: "POST", params: { AJAX_POST: "Y", MODE: "LIST" }, bodyType: "form", responseType: "json" };
    throw new Error(`call "${name}" is not allowed`);
  },
  names: () => ["task.comments.page", "task.comments.navigate"],
};

function forumComment(id: number, body = `Комментарий ${id}`): string {
  return `<div class="feed-com-block-cover" bx-mpl-entity-id="${id}" bx-mpl-read-status="old">` +
    `<div class="feed-com-block blog-comment-user-7"><div class="feed-com-user-box">` +
    `<a class="feed-com-name" bx-tooltip-user-id="7">Пётр</a><a class="feed-com-time">4 мая 2025 09:30</a></div>` +
    `<div class="feed-com-text-inner-inner">${body}</div></div></div>`;
}

function commentsPage(ids: number[], withOlder: boolean): { contentType: string; text: string } {
  const nav = withOlder ? `<a id="TASK_42-7_Xy_page_nav">Предыдущие комментарии</a>` : "";
  return {
    contentType: "text/html",
    text: `<div>${nav}${ids.map((id) => forumComment(id)).join("")}</div>` +
      `<script>new FCList({ EXEMPLAR_ID : '7_Xy', ajax : {"componentName":"bitrix:forum.comments","params":"c2lnbmVk.sig"} });</script>`,
  };
}

function navigatePage(ids: number[], more: boolean) {
  return { status: "success", messageList: ids.map((id) => forumComment(id)).join(""), navigation: more ? "<a>ещё</a>" : "" };
}

function commentsDeps(call: ReturnType<typeof mock>, downloadsDir?: string) {
  return {
    sink: { call, status: async () => ({ portals: [] }) },
    catalog: commentsCatalog,
    defaultPortal: "d",
    portals: ["d"],
    origins: { d: "https://d.bitrix24.ru" },
    downloadsDir,
  };
}

describe("bitrix_task_comments", () => {
  it("reads the first page, then pages back with the signed parameters until the start", async () => {
    const { server, handlers } = fakeServer();
    const call = mock()
      .mockResolvedValueOnce(commentsPage([30, 31], true))
      .mockResolvedValueOnce(navigatePage([20, 21], true))
      .mockResolvedValueOnce(navigatePage([10], false));
    registerTools(server, commentsDeps(call));

    const payload = JSON.parse((await handlers["bitrix_task_comments"]({ taskId: 42 })).content[0].text);

    expect(call.mock.calls[0][1]).toMatchObject({ endpoint: "/task/comments/{taskId}/", method: "GET", responseType: "text", params: { taskId: 42 } });
    expect(call.mock.calls[1][1]).toMatchObject({
      endpoint: NAVIGATE_ENDPOINT,
      method: "POST",
      params: { AJAX_POST: "Y", MODE: "LIST", ENTITY_XML_ID: "TASK_42", EXEMPLAR_ID: "7_Xy", "FILTER[<ID]": 30, taskId: 42, signedParameters: "c2lnbmVk.sig" },
    });
    expect(call.mock.calls[2][1].params["FILTER[<ID]"]).toBe(20);
    expect(payload.comments.map((c: { id: number }) => c.id)).toEqual([10, 20, 21, 30, 31]);
    expect(payload).toMatchObject({ taskId: 42, total: 5, reachedHistoryStart: true, oldestId: 10, scannedPages: 2 });
  });

  it("makes a single request when the first page already holds the whole discussion", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValueOnce(commentsPage([5, 6], false));
    registerTools(server, commentsDeps(call));

    const payload = JSON.parse((await handlers["bitrix_task_comments"]({ taskId: 42 })).content[0].text);

    expect(call).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({ total: 2, reachedHistoryStart: true, scannedPages: 0 });
  });

  it("stops at maxPages and says where to continue", async () => {
    const { server, handlers } = fakeServer();
    const call = mock()
      .mockResolvedValueOnce(commentsPage([30], true))
      .mockResolvedValueOnce(navigatePage([20], true));
    registerTools(server, commentsDeps(call));

    const payload = JSON.parse((await handlers["bitrix_task_comments"]({ taskId: 42, maxPages: 1 })).content[0].text);

    expect(payload).toMatchObject({ reachedHistoryStart: false, oldestId: 20, scannedPages: 1 });
  });

  it("continues from beforeId, using the first page only for a fresh signature", async () => {
    const { server, handlers } = fakeServer();
    const call = mock()
      .mockResolvedValueOnce(commentsPage([30], true))
      .mockResolvedValueOnce(navigatePage([10], false));
    registerTools(server, commentsDeps(call));

    const payload = JSON.parse((await handlers["bitrix_task_comments"]({ taskId: 42, beforeId: 20 })).content[0].text);

    expect(call.mock.calls[1][1].params["FILTER[<ID]"]).toBe(20);
    expect(payload.comments.map((c: { id: number }) => c.id)).toEqual([10]);
    expect(payload.reachedHistoryStart).toBe(true);
  });

  it("returns only the latest `limit` comments without paging further than needed", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValueOnce(commentsPage([30, 31, 32], true));
    registerTools(server, commentsDeps(call));

    const payload = JSON.parse((await handlers["bitrix_task_comments"]({ taskId: 42, limit: 2 })).content[0].text);

    expect(call).toHaveBeenCalledTimes(1);
    expect(payload.comments.map((c: { id: number }) => c.id)).toEqual([31, 32]);
    expect(payload).toMatchObject({ reachedHistoryStart: false, oldestId: 31 });
  });

  it("spills a long discussion to disk and returns the paths", async () => {
    const { server, handlers } = fakeServer();
    const dir = tempDir();
    const ids = Array.from({ length: 200 }, (_, i) => 1000 + i);
    const call = mock().mockResolvedValueOnce(commentsPage(ids, false));
    registerTools(server, commentsDeps(call, dir));

    const payload = JSON.parse((await handlers["bitrix_task_comments"]({ taskId: 42 })).content[0].text);

    expect(payload.comments).toEqual([]);
    expect(payload.total).toBe(200);
    expect(payload.files).toEqual({ text: join(dir, "task-42-comments.txt"), json: join(dir, "task-42-comments.json") });
    expect(readFileSync(payload.files.text, "utf8")).toContain("#1000 [2025-05-04T09:30] Пётр (id 7): Комментарий 1000");
    expect(JSON.parse(readFileSync(payload.files.json, "utf8")).comments).toHaveLength(200);
  });

  it("keeps a short discussion inline, and honours output:file / output:inline", async () => {
    const dir = tempDir();
    const ids = Array.from({ length: 200 }, (_, i) => 1000 + i);

    const short = fakeServer();
    registerTools(short.server, commentsDeps(mock().mockResolvedValue(commentsPage([1], false)), dir));
    expect(JSON.parse((await short.handlers["bitrix_task_comments"]({ taskId: 42 })).content[0].text).comments).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(JSON.parse((await short.handlers["bitrix_task_comments"]({ taskId: 42, output: "file" })).content[0].text).files).toBeDefined();

    const long = fakeServer();
    registerTools(long.server, commentsDeps(mock().mockResolvedValue(commentsPage(ids, false)), tempDir()));
    expect(JSON.parse((await long.handlers["bitrix_task_comments"]({ taskId: 42, output: "inline" })).content[0].text).comments).toHaveLength(200);
  });

  it("does not claim the whole history when `limit` cut older comments off", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValueOnce(commentsPage([30, 31, 32], false));
    registerTools(server, commentsDeps(call));

    const payload = JSON.parse((await handlers["bitrix_task_comments"]({ taskId: 42, limit: 2 })).content[0].text);

    expect(payload).toMatchObject({ total: 2, reachedHistoryStart: false, oldestId: 31 });
  });

  it("rejects a non-numeric taskId before it can name a file or reach the portal", async () => {
    const { server, handlers } = fakeServer();
    const call = mock();
    registerTools(server, commentsDeps(call, tempDir()));

    const bad = await handlers["bitrix_task_comments"]({ taskId: "../../escape", output: "file" });
    const badCursor = await handlers["bitrix_task_comments"]({ taskId: 42, beforeId: "abc" });

    expect(bad.isError).toBe(true);
    expect(badCursor.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("surfaces a login page as an error instead of an empty discussion", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValueOnce({ contentType: "text/html", text: "<form id='auth'></form>" });
    registerTools(server, commentsDeps(call));

    const res = await handlers["bitrix_task_comments"]({ taskId: 42 });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not a task comments page");
  });

  it("is not registered without both catalog entries", () => {
    const { server, handlers } = fakeServer();
    registerTools(server, { ...commentsDeps(mock()), catalog: { ...commentsCatalog, names: () => ["task.comments.page"] } });
    expect(handlers["bitrix_task_comments"]).toBeUndefined();
  });
});

describe("download tools", () => {
  const deps = (call: ReturnType<typeof mock>, downloadsDir = "/tmp/br24-downloads") => ({
    sink: { call, status: async () => ({ portals: [] }) },
    catalog: callCatalog,
    defaultPortal: "d",
    portals: ["d"],
    origins: { d: "https://d.bitrix24.ru" },
    downloadsDir,
  });

  it("bitrix_file_download streams to a temp file, then names it as the portal did", async () => {
    const { server, handlers } = fakeServer();
    const dir = tempDir();
    const call = mock().mockImplementation(async (_portal: string, target: { savePath: string }) => {
      writeFileSync(target.savePath, "png-bytes"); // stand-in for the daemon writing the body
      return { path: target.savePath, bytes: 245320, contentType: "image/jpeg", fileName: "image (29).png" };
    });
    registerTools(server, deps(call, dir));

    const res = await handlers["bitrix_file_download"]({
      url: "https://d.bitrix24.ru/bitrix/services/main/ajax.php?action=disk.api.file.download&fileId=180435&fileName=image%20%2829%29.png",
    });

    const target = call.mock.calls[0][1];
    expect(call.mock.calls[0][0]).toBe("d");
    expect(target.responseType).toBe("binary");
    expect(target.method).toBe("GET");
    expect(target.endpoint).toBe("/bitrix/services/main/ajax.php?action=disk.api.file.download&fileId=180435&fileName=image%20%2829%29.png");
    expect(target.savePath.endsWith(".part")).toBe(true); // never the guessed final name
    const payload = JSON.parse(res.content[0].text);
    expect(payload.path).toBe(join(dir, "image (29).png"));
    expect(payload.bytes).toBe(245320);
    expect(existsSync(target.savePath)).toBe(false);
  });

  it("bitrix_file_download refuses a repeat download over an existing file", async () => {
    const { server, handlers } = fakeServer();
    const dir = tempDir();
    writeFileSync(join(dir, "photo.png"), "already here");
    const call = mock().mockImplementation(async (_portal: string, target: { savePath: string }) => {
      writeFileSync(target.savePath, "new bytes");
      return { path: target.savePath, bytes: 9, contentType: "image/png", fileName: "photo.png" };
    });
    registerTools(server, deps(call, dir));

    const res = await handlers["bitrix_file_download"]({ url: "https://d.bitrix24.ru/x?action=disk.api.file.download&fileId=1" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/already exists/);
    expect(readFileSync(join(dir, "photo.png"), "utf8")).toBe("already here");
    expect(call.mock.calls[0][1].savePath).toBeDefined();
    expect(existsSync(call.mock.calls[0][1].savePath)).toBe(false); // temp cleaned up
  });

  it("bitrix_file_download writes straight to an explicit savePath", async () => {
    const { server, handlers } = fakeServer();
    const dir = tempDir();
    const call = mock().mockImplementation(async (_portal: string, target: { savePath: string }) => {
      writeFileSync(target.savePath, "x");
      return { path: target.savePath, bytes: 1, contentType: "image/png", fileName: "server-name.png" };
    });
    registerTools(server, deps(call, dir));

    const res = await handlers["bitrix_file_download"]({ url: "https://d.bitrix24.ru/x?action=disk.api.file.download", savePath: join(dir, "chosen.png") });

    expect(call.mock.calls[0][1].savePath).toBe(join(dir, "chosen.png"));
    expect(JSON.parse(res.content[0].text).path).toBe(join(dir, "chosen.png")); // server name ignored on purpose
  });

  it("bitrix_file_download refuses a URL outside the configured portals", async () => {
    const { server, handlers } = fakeServer();
    const call = mock();
    registerTools(server, deps(call));

    const res = await handlers["bitrix_file_download"]({ url: "https://evil.example/payload.exe" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not a configured portal/);
    expect(call).not.toHaveBeenCalled();
  });

  it("bitrix_call_recording resolves the link from the call detail, then downloads it", async () => {
    const { server, handlers } = fakeServer();
    const audio = "/bitrix/services/main/ajax.php?action=call.Track.download&SITE_ID=s1&signedParameters=sp.sig";
    const page = `<div data-call-id="4242"><div class="bx-call-component-call-ai__call-audio-record" data-audio-src="${audio}"></div></div>`;
    const dir = tempDir();
    const call = mock()
      .mockImplementationOnce(async () => ({ contentType: "text/html", text: page }))
      .mockImplementationOnce(async (_portal: string, target: { savePath: string }) => {
        writeFileSync(target.savePath, "ogg");
        return { path: target.savePath, bytes: 1024, contentType: "audio/ogg", fileName: "Запись звонка N4242.ogg" };
      });
    registerTools(server, deps(call, dir));

    const res = await handlers["bitrix_call_recording"]({ callId: 4242 });

    expect(call.mock.calls[0][1].endpoint).toBe("/call/detail/{callId}"); // detail first
    const download = call.mock.calls[1][1];
    expect(download.responseType).toBe("binary");
    expect(download.endpoint).toBe(audio);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.path).toBe(join(dir, "Запись звонка N4242.ogg")); // portal name wins over "ajax.php"
    expect(payload.contentType).toBe("audio/ogg");
  });

  it("bitrix_call_recording reports calls that were never recorded", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ contentType: "text/html", text: '<div data-call-id="4242"></div>' });
    registerTools(server, deps(call));

    const res = await handlers["bitrix_call_recording"]({ callId: 4242 });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no recording/);
    expect(call).toHaveBeenCalledTimes(1); // no download attempted
  });

  it("skips download tools when no downloads directory is configured", async () => {
    const { server, handlers } = fakeServer();
    registerTools(server, { sink: { call: mock(), status: async () => ({ portals: [] }) }, catalog: callCatalog, defaultPortal: "d", portals: ["d"] });
    expect(handlers["bitrix_file_download"]).toBeUndefined();
  });
});
