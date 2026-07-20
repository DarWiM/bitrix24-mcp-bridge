import { describe, it, expect, mock } from "bun:test";
import { registerTools } from "./register.js";
import type { Catalog } from "../catalog/catalog.js";

function fakeServer() {
  const handlers: Record<string, Function> = {};
  return {
    server: { registerTool: (n: string, _s: unknown, h: Function) => (handlers[n] = h), registerResource: () => {} } as any,
    handlers,
  };
}

const catalog: Catalog = {
  resolve: (name) => {
    const map: Record<string, any> = {
      "tasks.list": { endpoint: "/bitrix/services/main/ajax.php", action: "tasks.task.list", method: "POST", params: {} },
      "chat.messages": { endpoint: "/rest/im.dialog.messages.get", action: null, method: "POST", params: {} },
    };
    if (!map[name]) throw new Error("not allowed");
    return map[name];
  },
  names: () => ["tasks.list", "chat.messages"],
};

describe("typed tools", () => {
  it("registers a tasks tool that forwards the mapped CallTarget with the default portal", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ tasks: [] });
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog, defaultPortal: "default", portals: ["default"] });

    expect(handlers["bitrix_tasks_list"]).toBeTypeOf("function");
    // default select/order applied; agent params merged last and override defaults
    await handlers["bitrix_tasks_list"]({ params: { filter: { REAL_STATUS: 2 }, order: { ID: "asc" } } });
    expect(call).toHaveBeenCalledWith("default", expect.objectContaining({
      action: "tasks.task.list",
      params: expect.objectContaining({
        select: ["ID", "TITLE", "STATUS", "RESPONSIBLE_ID", "CREATED_BY", "DEADLINE", "GROUP_ID", "PRIORITY"],
        filter: { REAL_STATUS: 2 },
        order: { ID: "asc" }, // overrides the default { ID: "desc" }
      }),
    }));
  });

  it("forwards an explicit portal for a typed tool instead of the default", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ tasks: [] });
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog, defaultPortal: "default", portals: ["default", "other"] });

    await handlers["bitrix_tasks_list"]({ portal: "other" });
    expect(call).toHaveBeenCalledWith("other", expect.objectContaining({ action: "tasks.task.list" }));
  });

  it("applies default limit=20 for chat messages and does NOT page backward (.list)", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ messages: [] });
    registerTools(server, { sink: { call, status: async () => ({ portals: [] }) }, catalog, defaultPortal: "default", portals: ["default"] });

    // im.v2.Chat.Message.list returns only the latest page — beforeId is unsupported here
    // (deep paging lives in bitrix_chat_history). So no filter[lastId] leaks through.
    await handlers["bitrix_chat_messages"]({ chatId: "485", beforeId: 84869 });
    const target = call.mock.calls[0][1];
    expect(target.params).toEqual({ chatId: "485", limit: 20 });
    expect(target.params["filter[lastId]"]).toBeUndefined();
  });

  it("skips a typed tool whose catalog name is absent", () => {
    const { server, handlers } = fakeServer();
    registerTools(server, { sink: { call: mock(), status: async () => ({ portals: [] }) }, catalog, defaultPortal: "default", portals: ["default"] });
    expect(handlers["bitrix_projects_list"]).toBeUndefined();
  });
});
