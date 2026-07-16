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
      return { endpoint: "/bitrix/services/main/ajax.php", action: "tasks.task.list", method: "POST", params: { FILTER: {} } };
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
