import { describe, it, expect, mock } from "bun:test";
import { registerTools } from "./register.js";
import type { Catalog } from "../catalog/catalog.js";

function fakeServer() {
  const handlers: Record<string, Function> = {};
  const server = { registerTool: (n: string, _s: unknown, h: Function) => { handlers[n] = h; }, registerResource: () => {} };
  return { server: server as any, handlers };
}

const catalog: Catalog = {
  resolve: (name) => {
    if (name === "tasks.list")
      return { endpoint: "/bitrix/services/main/ajax.php", action: "tasks.task.list", method: "POST", params: { FILTER: {} }, bodyType: "form" };
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
    expect(payload).toEqual({
      configured: true,
      defaultPortal: "acme",
      portals: [{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: true }],
    });
  });
});

const AJAX = "/bitrix/services/main/ajax.php";
const richEntries: Record<string, { endpoint: string; action: string | null; bodyType: "json" | "form"; params?: Record<string, unknown> }> = {
  "task.v2.get": { endpoint: AJAX, action: "tasks.v2.Task.get", bodyType: "json" },
  "chat.load": { endpoint: AJAX, action: "im.v2.Chat.load", bodyType: "form", params: { messageLimit: 25 } },
  "chat.messages.tail": { endpoint: AJAX, action: "im.v2.Chat.Message.tail", bodyType: "form", params: { "order[id]": "DESC", limit: 25 } },
  "chat.message.read": { endpoint: AJAX, action: "im.v2.Chat.Message.read", bodyType: "form" },
  "recent.load": { endpoint: AJAX, action: "im.v2.Recent.load", bodyType: "form" },
  "entityselector.search": { endpoint: AJAX, action: "ui.entityselector.doSearch", bodyType: "json" },
  "chat.read.all": { endpoint: AJAX, action: "im.v2.Chat.readAll", bodyType: "form" },
  "task.subtasks": { endpoint: AJAX, action: "tasks.v2.Task.Relation.Child.list", bodyType: "json" },
  "im.user.get": { endpoint: "/rest/im.user.get.json", action: null, bodyType: "form" },
};
const richCatalog: Catalog = {
  resolve: (name) => {
    const e = richEntries[name];
    if (!e) throw new Error(`call "${name}" is not allowed`);
    return { endpoint: e.endpoint, action: e.action, method: "POST", params: e.params ?? {}, bodyType: e.bodyType };
  },
  names: () => Object.keys(richEntries),
};

describe("typed tools — json / pagination / write", () => {
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
