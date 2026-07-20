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

const richCatalog: Catalog = {
  resolve: (name) => {
    if (name === "task.v2.get")
      return { endpoint: "/bitrix/services/main/ajax.php", action: "tasks.v2.Task.get", method: "POST", params: {}, bodyType: "json" };
    if (name === "chat.load")
      return { endpoint: "/bitrix/services/main/ajax.php", action: "im.v2.Chat.load", method: "POST", params: { messageLimit: 25 }, bodyType: "form" };
    if (name === "chat.messages.tail")
      return { endpoint: "/bitrix/services/main/ajax.php", action: "im.v2.Chat.Message.tail", method: "POST", params: { "order[id]": "DESC", limit: 25 }, bodyType: "form" };
    if (name === "chat.message.read")
      return { endpoint: "/bitrix/services/main/ajax.php", action: "im.v2.Chat.Message.read", method: "POST", params: {}, bodyType: "form" };
    throw new Error(`call "${name}" is not allowed`);
  },
  names: () => ["task.v2.get", "chat.load", "chat.messages.tail", "chat.message.read"],
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
      params: expect.objectContaining({ task: 4229 }),
    }));
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
