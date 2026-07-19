import { describe, it, expect } from "bun:test";
import { newAccumulator, addSample, fingerprint, toObject, type SampleMeta } from "./draft.js";

const meta: SampleMeta = {
  endpoint: "/bitrix/services/main/ajax.php",
  action: "getColumnItems",
  method: "POST",
  transport: "ajax",
  bodyType: "form",
};

describe("fingerprint", () => {
  it("is invariant to key order, including nested", () => {
    expect(fingerprint({ a: 1, b: { x: 1, y: 2 } })).toBe(fingerprint({ b: { y: 2, x: 1 }, a: 1 }));
  });
  it("differs when a value differs", () => {
    expect(fingerprint({ a: "1" })).not.toBe(fingerprint({ a: "2" }));
  });
});

describe("addSample", () => {
  it("keys by action, accumulates unique param sets, dedups identical ones", () => {
    const acc = newAccumulator();
    expect(addSample(acc, meta, { pageId: "5" })).toBe("new-action");
    expect(addSample(acc, meta, { pageId: "5" })).toBe("duplicate");
    expect(addSample(acc, meta, { pageId: "6" })).toBe("new-variant");
    expect(addSample(acc, meta, { pageId: "5", extra: "1" })).toBe("new-variant");

    const out = toObject(acc);
    expect(out.getColumnItems.sampleParams).toEqual([
      { pageId: "5" },
      { pageId: "6" },
      { pageId: "5", extra: "1" },
    ]);
    expect(out.getColumnItems.bodyType).toBe("form");
  });

  it("keys REST calls (null action) by endpoint", () => {
    const acc = newAccumulator();
    const rest: SampleMeta = { endpoint: "/rest/im.user.get.json", action: null, method: "POST", transport: "rest", bodyType: "form" };
    addSample(acc, rest, { ID: "11" });
    expect(Object.keys(toObject(acc))).toEqual(["/rest/im.user.get.json"]);
  });

  it("logs a warning on mixed bodyType but keeps the first", () => {
    const acc = newAccumulator();
    const seen: string[] = [];
    const orig = console.error;
    console.error = (m?: unknown) => { seen.push(String(m)); };
    try {
      addSample(acc, meta, { a: "1" });
      addSample(acc, { ...meta, bodyType: "json" }, { a: "2" });
    } finally {
      console.error = orig;
    }
    expect(seen.some((m) => m.includes("mixed bodyType"))).toBe(true);
    expect(toObject(acc).getColumnItems.bodyType).toBe("form");
  });
});
