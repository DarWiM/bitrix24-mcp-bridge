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
});
