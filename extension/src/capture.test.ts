import { describe, it, expect } from "bun:test";
import { toCaptured } from "./capture.ts";

const BASE = "https://example.bitrix24.ru";

describe("toCaptured", () => {
  it("captures an ajax.php action and strips sessid from the body", () => {
    const c = toCaptured(
      "https://example.bitrix24.ru/bitrix/services/main/ajax.php?action=tasks.task.list",
      "POST",
      "filter[ID]=5&sessid=abc",
      BASE,
    );
    expect(c).toEqual({
      endpoint: "/bitrix/services/main/ajax.php",
      action: "tasks.task.list",
      method: "POST",
      transport: "ajax",
      sampleParams: { "filter[ID]": "5" },
    });
  });

  it("captures a /rest/*.json endpoint as transport rest with null action", () => {
    const c = toCaptured("/rest/im.recent.list.json", "POST", "LIMIT=50", BASE);
    expect(c?.transport).toBe("rest");
    expect(c?.action).toBeNull();
    expect(c?.endpoint).toBe("/rest/im.recent.list.json");
    expect(c?.sampleParams).toEqual({ LIMIT: "50" });
  });

  it("drops static assets even under /rest/ paths", () => {
    expect(toCaptured("/bitrix/js/rest/client/rest.client.min.js", "GET", null, BASE)).toBeNull();
    expect(toCaptured("/bitrix/js/rest/css/applayout.min.css", "GET", null, BASE)).toBeNull();
  });

  it("drops non-API same-origin URLs and cross-origin URLs", () => {
    expect(toCaptured("/company/personal/", "GET", null, BASE)).toBeNull();
    expect(toCaptured("https://evil.example/rest/x.json", "POST", "a=1", BASE)).toBeNull();
  });
});
