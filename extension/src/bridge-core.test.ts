import { describe, it, expect } from "bun:test";
import {
  encodeForm,
  buildRequest,
  interpret,
  interpretText,
  applyPathParams,
  toBase64,
  looksLikeLoginPage,
  fileNameFromDisposition,
} from "./bridge-core.ts";

describe("encodeForm", () => {
  it("serializes nested objects PHP-style", () => {
    const p = new URLSearchParams(encodeForm({ FILTER: { STATUS: 2 }, PAGE: 1 }));
    expect(p.get("FILTER[STATUS]")).toBe("2");
    expect(p.get("PAGE")).toBe("1");
  });
});

describe("buildRequest", () => {
  it("targets ajax.php with action, form body, sessid inline, urlencoded contentType", () => {
    const { url, body, contentType } = buildRequest(
      "https://portal.bitrix24.ru",
      { type: "call", id: "1", endpoint: "/bitrix/services/main/ajax.php", action: "tasks.task.list", method: "POST", params: { PAGE: 2 } },
      "fresh-sessid",
    );
    expect(url).toBe("https://portal.bitrix24.ru/bitrix/services/main/ajax.php?action=tasks.task.list");
    expect(contentType).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(body).get("sessid")).toBe("fresh-sessid");
    expect(new URLSearchParams(body).get("PAGE")).toBe("2");
  });

  it("sends a JSON body for bodyType json, sessid NOT in the body, json contentType", () => {
    const { url, body, contentType } = buildRequest(
      "https://portal.bitrix24.ru",
      { type: "call", id: "9", endpoint: "/bitrix/services/main/ajax.php", action: "ui.entityselector.load", method: "POST", params: { dialog: { id: "x" } }, bodyType: "json" },
      "fresh-sessid",
    );
    expect(url).toBe("https://portal.bitrix24.ru/bitrix/services/main/ajax.php?action=ui.entityselector.load");
    expect(contentType).toBe("application/json");
    expect(JSON.parse(body)).toEqual({ dialog: { id: "x" } });
    expect(body).not.toContain("fresh-sessid");
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
  it("treats an empty errors[] array (present in ajax success responses) as success", () => {
    const payload = { status: "success", data: { tasks: [] }, errors: [] };
    expect(interpret(payload)).toEqual({ ok: true, data: payload });
  });
  it("surfaces error_description alongside the top-level error code", () => {
    const r = interpret({ error: "QUERY_LIMIT_EXCEEDED", error_description: "too many" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("QUERY_LIMIT_EXCEEDED");
    expect(r.error).toContain("too many");
  });
});

describe("applyPathParams", () => {
  it("fills {name} from params and consumes the key", () => {
    const { endpoint, rest } = applyPathParams("/call/detail/{callId}", { callId: 4242, IFRAME: "Y" });
    expect(endpoint).toBe("/call/detail/4242");
    expect(rest).toEqual({ IFRAME: "Y" });
  });

  it("leaves a plain endpoint and its params untouched", () => {
    const { endpoint, rest } = applyPathParams("/rest/im.user.get.json", { ID: 55 });
    expect(endpoint).toBe("/rest/im.user.get.json");
    expect(rest).toEqual({ ID: 55 });
  });

  it("throws when the path param is missing rather than building a broken URL", () => {
    expect(() => applyPathParams("/call/detail/{callId}", {})).toThrow(/missing path param "callId"/);
  });

  it("escapes the substituted value", () => {
    expect(applyPathParams("/x/{id}", { id: "a b/c" }).endpoint).toBe("/x/a%20b%2Fc");
  });
});

describe("buildRequest with a path template", () => {
  it("substitutes into the URL and keeps the id out of the query", () => {
    const { url, body } = buildRequest(
      "https://portal.bitrix24.ru",
      { type: "call", id: "7", endpoint: "/call/detail/{callId}", action: null, method: "GET", params: { callId: 4242, IFRAME: "Y" } },
      "s",
    );
    expect(url).toBe("https://portal.bitrix24.ru/call/detail/4242");
    const parsed = new URLSearchParams(body);
    expect(parsed.get("IFRAME")).toBe("Y");
    expect(parsed.get("callId")).toBeNull();
  });
});

describe("interpretText", () => {
  it("returns the body and its content type on success", () => {
    expect(interpretText("<html>x</html>", "text/html; charset=UTF-8", 200)).toEqual({
      ok: true,
      data: { contentType: "text/html; charset=UTF-8", text: "<html>x</html>" },
    });
  });

  it("fails on an HTTP error status", () => {
    expect(interpretText("<html>nope</html>", "text/html", 403)).toEqual({ ok: false, error: "HTTP 403" });
  });

  it("fails on an empty body instead of reporting success", () => {
    expect(interpretText("   ", "text/html", 200)).toEqual({ ok: false, error: "empty response" });
  });
});

describe("binary download helpers", () => {
  it("base64-encodes bytes the same way Buffer would", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("handles a payload larger than the fromCharCode window without truncating", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 123).map((_, i) => i % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("flags an HTML body with no attachment marker as the login page", () => {
    expect(looksLikeLoginPage("text/html; charset=UTF-8", null)).toBe(true);
    expect(looksLikeLoginPage("text/html", "inline")).toBe(true);
  });

  it("lets a real HTML attachment through", () => {
    expect(looksLikeLoginPage("text/html", 'attachment; filename="report.html"')).toBe(false);
  });

  it("does not flag ordinary file types", () => {
    expect(looksLikeLoginPage("image/png", null)).toBe(false);
    expect(looksLikeLoginPage("audio/mpeg", null)).toBe(false);
  });

  it("reads the file name from Content-Disposition, plain and RFC 5987", () => {
    expect(fileNameFromDisposition('attachment; filename="image (29).png"')).toBe("image (29).png");
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''%D1%84%D0%BE%D1%82%D0%BE.png")).toBe("фото.png");
    expect(fileNameFromDisposition(null)).toBeNull();
  });
});
