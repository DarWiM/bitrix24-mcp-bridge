import { describe, it, expect, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { registerTools, type ToolDeps } from "./register.js";
import { OPERATIONS } from "../ops/index.js";
import { defineOperation, idArg, type Operation } from "../ops/operation.js";
import type { DaemonStatus } from "../bridge/uds-client.js";

// A real server and client over an in-memory link, so tool listing also proves every
// operation's input converts to a JSON schema.
async function connect(deps: ToolDeps): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const toolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

function readResult(res: unknown) {
  const parsed = toolResult.parse(res);
  return { isError: parsed.isError ?? false, text: parsed.content[0].text };
}

const noStatus = async (): Promise<DaemonStatus> => ({ portals: [], version: "0.0.0-dev" });

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    sink: { op: mock(), status: noStatus },
    operations: OPERATIONS,
    defaultPortal: "acme",
    portals: ["acme"],
    ...overrides,
  };
}

const echoOp: Operation = defineOperation({
  name: "echo",
  description: "echo test",
  mutating: false,
  input: { taskId: idArg(), note: z.string().optional() },
  run: async () => null,
});

describe("registerTools", () => {
  it("serves exactly the operations plus help and status — no bitrix_call", async () => {
    const client = await connect(deps());
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name).sort();
    const expected = ["bitrix_help", "bitrix_status", ...OPERATIONS.map((op) => `bitrix_${op.name}`)].sort();
    expect(names).toEqual(expected);
    expect(names).not.toContain("bitrix_call");
  });

  it("describes each operation tool with the operation's text and inputs plus an optional portal", async () => {
    const client = await connect(deps());
    const { tools } = await client.listTools();

    for (const op of OPERATIONS) {
      const tool = tools.find((t) => t.name === `bitrix_${op.name}`);
      expect(tool?.description).toBe(op.description);
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([...Object.keys(op.input), "portal"].sort());
      expect(tool?.inputSchema.required ?? []).not.toContain("portal");
    }
  });

  it("forwards the portal, the operation name and the remaining args to the daemon", async () => {
    const op = mock().mockResolvedValue({ id: 7 });
    const client = await connect(deps({ sink: { op, status: noStatus }, operations: [echoOp] }));

    const res = readResult(await client.callTool({ name: "bitrix_echo", arguments: { taskId: 7, note: "hi", portal: "beta" } }));

    expect(op).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledWith("beta", "echo", { taskId: 7, note: "hi" }, "call");
    expect(res).toEqual({ isError: false, text: JSON.stringify({ id: 7 }) });
  });

  it("leaves the portal to the daemon when the caller names none", async () => {
    const op = mock().mockResolvedValue(null);
    const client = await connect(deps({ sink: { op, status: noStatus }, operations: [echoOp] }));

    await client.callTool({ name: "bitrix_echo", arguments: { taskId: 3 } });

    expect(op).toHaveBeenCalledWith(undefined, "echo", { taskId: 3 }, "call");
  });

  it("passes the operation's time budget along, so a multi-page scan is not cut off", async () => {
    const op = mock().mockResolvedValue(null);
    const scan = defineOperation({ name: "scan", description: "test", mutating: false, budget: "long", input: {}, run: async () => null });
    const client = await connect(deps({ sink: { op, status: noStatus }, operations: [scan] }));

    await client.callTool({ name: "bitrix_scan", arguments: {} });

    expect(op).toHaveBeenCalledWith(undefined, "scan", {}, "long");
  });

  it("returns a daemon error as an error result", async () => {
    const op = mock().mockRejectedValue(new Error('unknown portal "nope"'));
    const client = await connect(deps({ sink: { op, status: noStatus }, operations: [echoOp] }));

    const res = readResult(await client.callTool({ name: "bitrix_echo", arguments: { taskId: 3, portal: "nope" } }));

    expect(res).toEqual({ isError: true, text: 'unknown portal "nope"' });
  });
});

describe("bitrix_status tool", () => {
  async function status(portals: DaemonStatus["portals"]) {
    const client = await connect(deps({ sink: { op: mock(), status: async () => ({ portals, version: "0.0.0-dev" }) } }));
    return JSON.parse(readResult(await client.callTool({ name: "bitrix_status", arguments: {} })).text);
  }

  it("reports the default portal and each portal's connection state", async () => {
    const payload = await status([{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: true }]);
    expect(payload).toMatchObject({
      configured: true,
      defaultPortal: "acme",
      portals: [{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: true }],
    });
  });

  it("warns when the connected extension is older than the bridge", async () => {
    const payload = await status([{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: true, extensionVersion: "0.2.1" }]);

    expect(payload.warning).toMatch(/устарело/);
    expect(payload.warning).toContain("0.2.1");
    expect(payload.warning).toContain("chrome://extensions");
  });

  it("does not warn about a portal that is not connected", async () => {
    const payload = await status([{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: false, extensionVersion: null }]);

    expect(payload.warning).toBeUndefined();
  });
});
