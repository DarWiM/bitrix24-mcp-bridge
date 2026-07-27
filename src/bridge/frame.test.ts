import { describe, it, expect } from "bun:test";
import { encodeFrame, FrameDecoder } from "./frame.js";

describe("frame", () => {
  it("round-trips a message", () => {
    const d = new FrameDecoder();
    expect(d.push(encodeFrame({ a: 1 }))).toEqual([{ a: 1 }]);
  });

  it("reassembles a message split across chunks", () => {
    const d = new FrameDecoder();
    const wire = encodeFrame({ hello: "world" });
    expect(d.push(wire.slice(0, 5))).toEqual([]);
    expect(d.push(wire.slice(5))).toEqual([{ hello: "world" }]);
  });

  it("returns multiple messages from one chunk", () => {
    const d = new FrameDecoder();
    expect(d.push(encodeFrame({ n: 1 }) + encodeFrame({ n: 2 }))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("keeps a multi-byte character intact when a chunk boundary splits it", () => {
    const d = new FrameDecoder();
    const wire = Buffer.from(encodeFrame({ name: "Дмитрий Николаев" }), "utf8");
    // Cut inside the two-byte "и" of "Дмитрий" — the naive per-chunk decode yields U+FFFD here.
    const cut = wire.indexOf(Buffer.from("итрий", "utf8")) + 1;
    expect(d.push(wire.subarray(0, cut))).toEqual([]);
    expect(d.push(wire.subarray(cut))).toEqual([{ name: "Дмитрий Николаев" }]);
  });

  it("survives a boundary in every position of a cyrillic payload", () => {
    const wire = Buffer.from(encodeFrame({ text: "Расшифровка звонка №1721 — обсуждение локализации" }), "utf8");
    for (let cut = 1; cut < wire.length; cut++) {
      const d = new FrameDecoder();
      const first = d.push(wire.subarray(0, cut));
      const second = d.push(wire.subarray(cut));
      expect([...first, ...second]).toEqual([{ text: "Расшифровка звонка №1721 — обсуждение локализации" }]);
    }
  });
});
