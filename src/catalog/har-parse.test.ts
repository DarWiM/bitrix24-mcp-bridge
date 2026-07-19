import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHar, missingTriadDomains, type CapturedCall } from "./har-parse.js";

const har = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/sample.har", import.meta.url)), "utf8"),
);

describe("parseHar", () => {
  it("captures calls, classifies transport, reads JSON text bodies, drops static", () => {
    const calls = parseHar(har);
    expect(calls).toHaveLength(3);

    const ajax = calls.find((c) => c.action === "tasks.task.list")!;
    expect(ajax.transport).toBe("ajax");
    expect(ajax.endpoint).toBe("/bitrix/services/main/ajax.php");
    expect(ajax.params).toEqual({ "params[ORDER][ID]": "desc" }); // sessid stripped
    expect(ajax.bodyType).toBe("form");

    const json = calls.find((c) => c.action === "ui.entityselector.doSearch")!;
    expect(json.bodyType).toBe("json");
    expect(json.params).toEqual({ dialog: { id: "x" }, searchQuery: { query: "hi" } });

    const rest = calls.find((c) => c.transport === "rest")!;
    expect(rest.endpoint).toBe("/rest/im.recent.list");
    expect(rest.action).toBeNull();
  });

  it("captures an entry kept solely by application/json mimeType as transport 'other'", () => {
    const har = {
      log: {
        entries: [
          {
            request: {
              method: "POST",
              url: "https://portal.bitrix24.ru/some/controller",
              postData: { params: [{ name: "foo", value: "bar" }] },
            },
            response: { content: { mimeType: "application/json" } },
          },
        ],
      },
    };
    const calls = parseHar(har);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.transport).toBe("other");
    expect(calls[0]!.endpoint).toBe("/some/controller");
  });
});

describe("missingTriadDomains", () => {
  it("does not count 'estimate' substring as chats coverage, but does count tasks", () => {
    const calls: CapturedCall[] = [
      {
        endpoint: "/bitrix/services/main/ajax.php",
        action: "tasks.task.estimate",
        method: "POST",
        params: {},
        transport: "ajax",
        bodyType: "form",
      },
    ];
    const missing = missingTriadDomains(calls);
    expect(missing).toContain("chats");
    expect(missing).not.toContain("tasks");
  });

  it("returns [] when all three triad domains are present", () => {
    const calls: CapturedCall[] = [
      {
        endpoint: "/bitrix/services/main/ajax.php",
        action: "tasks.task.list",
        method: "POST",
        params: {},
        transport: "ajax",
        bodyType: "form",
      },
      {
        endpoint: "/bitrix/services/main/ajax.php",
        action: "socialnetwork.api.workgroup.list",
        method: "POST",
        params: {},
        transport: "ajax",
        bodyType: "form",
      },
      {
        endpoint: "/rest/im.recent.list",
        action: null,
        method: "POST",
        params: {},
        transport: "rest",
        bodyType: "form",
      },
    ];
    expect(missingTriadDomains(calls)).toEqual([]);
  });
});
