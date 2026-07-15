import { describe, it, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "./catalog.js";

function fixture(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const p = join(dir, "actions.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("loadCatalog", () => {
  const path = fixture({
    "tasks.list": { action: "tasks.task.list" },
    "chats.recent": { endpoint: "/rest/im.recent.list" },
  });

  it("defaults endpoint to ajax.php and method to POST for an action entry", () => {
    expect(loadCatalog(path).resolve("tasks.list")).toEqual({
      endpoint: "/bitrix/services/main/ajax.php",
      action: "tasks.task.list",
      method: "POST",
      params: {},
    });
  });

  it("keeps an explicit rest endpoint with a null action", () => {
    expect(loadCatalog(path).resolve("chats.recent")).toEqual({
      endpoint: "/rest/im.recent.list",
      action: null,
      method: "POST",
      params: {},
    });
  });

  it("lists names and rejects names outside the allowlist", () => {
    const cat = loadCatalog(path);
    expect(cat.names()).toEqual(["tasks.list", "chats.recent"]);
    expect(() => cat.resolve("crm.deal.list")).toThrow(/not allowed/i);
  });

  it("rejects prototype-chain names not present as own properties in the catalog", () => {
    const cat = loadCatalog(path);
    expect(() => cat.resolve("constructor")).toThrow(/not allowed/i);
    expect(() => cat.resolve("toString")).toThrow(/not allowed/i);
    expect(() => cat.resolve("hasOwnProperty")).toThrow(/not allowed/i);
    expect(() => cat.resolve("__proto__")).toThrow(/not allowed/i);
  });
});
