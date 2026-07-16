import { describe, it, expect } from "bun:test";
import { registerUnconfiguredTools } from "./unconfigured.js";

describe("registerUnconfiguredTools", () => {
  it("registers help + status; status reports unconfigured with a setup hint", async () => {
    const tools = new Map<string, (args: any) => Promise<any>>();
    const server: any = { registerTool: (n: string, _s: any, h: any) => tools.set(n, h), registerResource: () => {} };
    registerUnconfiguredTools(server, "no portal origin configured");

    expect(tools.has("bitrix_help")).toBe(true);
    const status = await tools.get("bitrix_status")!({});
    const payload = JSON.parse(status.content[0].text);
    expect(payload.configured).toBe(false);
    expect(payload.reason).toMatch(/portal/i);
    expect(payload.hint).toContain("bitrix24-bridge setup");
  });
});
