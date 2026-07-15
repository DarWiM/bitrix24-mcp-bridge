// src/paths.test.ts
import { describe, it, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "./paths.js";

describe("runtimePaths", () => {
  it("defaults to ~/.bitrix24-mcp-bridge", () => {
    const p = runtimePaths({});
    expect(p.home).toBe(join(homedir(), ".bitrix24-mcp-bridge"));
    expect(p.configJson).toBe(join(p.home, "config.json"));
    expect(p.sock).toBe(join(p.home, "bridge.sock"));
    expect(p.lock).toBe(join(p.home, "bridge.lock"));
    expect(p.actionsJson).toBe(join(p.home, "actions.json"));
    expect(p.extensionDir).toBe(join(p.home, "extension"));
  });

  it("honors $BITRIX24_MCP_BRIDGE_HOME", () => {
    const p = runtimePaths({ BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24" });
    expect(p.home).toBe("/tmp/br24");
    expect(p.configJson).toBe("/tmp/br24/config.json");
  });
});
