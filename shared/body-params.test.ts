import { describe, it, expect } from "bun:test";
import { parseBody } from "./body-params.ts";

describe("parseBody", () => {
  it("parses a JSON object body into nested params, bodyType json", () => {
    const r = parseBody('{"dialog":{"id":"x"},"searchQuery":{"query":"hi"}}');
    expect(r.bodyType).toBe("json");
    expect(r.params).toEqual({ dialog: { id: "x" }, searchQuery: { query: "hi" } });
  });

  it("parses a JSON array body, bodyType json", () => {
    const r = parseBody('[{"a":1}]');
    expect(r.bodyType).toBe("json");
    expect(Array.isArray(r.params)).toBe(true);
  });

  it("parses urlencoded body into a flat record, bodyType form", () => {
    const r = parseBody("data[fields][STATUS][0]=2&LIMIT=50");
    expect(r.bodyType).toBe("form");
    expect(r.params).toEqual({ "data[fields][STATUS][0]": "2", LIMIT: "50" });
  });

  it("falls back to form when a {-leading string is not valid JSON", () => {
    const r = parseBody("{not json=1");
    expect(r.bodyType).toBe("form");
  });
});
