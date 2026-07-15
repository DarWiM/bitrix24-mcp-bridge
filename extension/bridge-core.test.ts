import { describe, it, expect } from "bun:test";
import { encodeForm, buildRequest, interpret } from "./bridge-core.js";

describe("encodeForm", () => {
  it("serializes nested objects PHP-style", () => {
    const p = new URLSearchParams(encodeForm({ FILTER: { STATUS: 2 }, PAGE: 1 }));
    expect(p.get("FILTER[STATUS]")).toBe("2");
    expect(p.get("PAGE")).toBe("1");
  });
});

describe("buildRequest", () => {
  it("targets ajax.php with action and injects a fresh sessid", () => {
    const { url, body } = buildRequest(
      "https://portal.bitrix24.ru",
      { type: "call", id: "1", endpoint: "/bitrix/services/main/ajax.php", action: "tasks.task.list", method: "POST", params: { PAGE: 2 } },
      "fresh-sessid",
    );
    expect(url).toBe("https://portal.bitrix24.ru/bitrix/services/main/ajax.php?action=tasks.task.list");
    expect(new URLSearchParams(body).get("sessid")).toBe("fresh-sessid");
    expect(new URLSearchParams(body).get("PAGE")).toBe("2");
  });

  it("reproduces a rest endpoint without an action query", () => {
    const { url } = buildRequest(
      "https://portal.bitrix24.ru",
      { type: "call", id: "2", endpoint: "/rest/im.recent.list", action: null, method: "POST", params: {} },
      "s",
    );
    expect(url).toBe("https://portal.bitrix24.ru/rest/im.recent.list");
  });

  it("builds a rest-style GET target with params and sessid in the body", () => {
    const { url, body } = buildRequest(
      "https://p.bitrix24.ru",
      { type: "call", id: "1", endpoint: "/rest/x", action: null, method: "GET", params: { A: 1 } },
      "s",
    );
    expect(url).toBe("https://p.bitrix24.ru/rest/x");
    const parsed = new URLSearchParams(body);
    expect(parsed.get("A")).toBe("1");
    expect(parsed.get("sessid")).toBe("s");
  });
});

describe("interpret", () => {
  it("maps a Bitrix error envelope to ok:false", () => {
    const r = interpret({ status: "error", errors: [{ code: "invalid_csrf" }] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid_csrf");
  });
  it("passes a normal payload through", () => {
    expect(interpret({ status: "success", data: { x: 1 } })).toEqual({ ok: true, data: { status: "success", data: { x: 1 } } });
  });
  it("surfaces error_description alongside the top-level error code", () => {
    const r = interpret({ error: "QUERY_LIMIT_EXCEEDED", error_description: "too many" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("QUERY_LIMIT_EXCEEDED");
    expect(r.error).toContain("too many");
  });
});
