import { describe, it, expect, mock } from "bun:test";
import { registerTools } from "./register.js";
import type { Catalog } from "../catalog/catalog.js";

function fakeServer() {
  const handlers: Record<string, Function> = {};
  return {
    server: { registerTool: (n: string, _s: unknown, h: Function) => (handlers[n] = h) } as any,
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
  it("registers a tasks tool that forwards the mapped CallTarget", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ tasks: [] });
    registerTools(server, { bridge: { call }, catalog });

    expect(handlers["bitrix_tasks_list"]).toBeTypeOf("function");
    await handlers["bitrix_tasks_list"]({ page: 2 });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      action: "tasks.task.list",
      params: { PAGE: 2 },
    }));
  });

  it("applies default limit=20 and maps beforeId to filter[lastId] (im.v2) for chat messages", async () => {
    const { server, handlers } = fakeServer();
    const call = mock().mockResolvedValue({ messages: [] });
    registerTools(server, { bridge: { call }, catalog });

    await handlers["bitrix_chat_messages"]({ chatId: "485", beforeId: 84869 });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      params: { chatId: "485", limit: 20, "filter[lastId]": 84869 },
    }));
  });

  it("skips a typed tool whose catalog name is absent", () => {
    const { server, handlers } = fakeServer();
    registerTools(server, { bridge: { call: mock() }, catalog });
    expect(handlers["bitrix_projects_list"]).toBeUndefined();
  });
});
