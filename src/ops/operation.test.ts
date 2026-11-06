import { describe, it, expect } from "bun:test";
import { agentParams, idArg } from "./operation.js";

describe("idArg", () => {
  it("accepts a positive integer as a number or a digit string", () => {
    expect(idArg().parse(42)).toBe(42);
    expect(idArg().parse("42")).toBe(42);
  });

  it("rejects zero, negatives and anything path-like or not purely digits", () => {
    for (const bad of [0, -1, 1.5, "../1", "1a", "", " 1", "-1"]) {
      expect(idArg().safeParse(bad).success).toBe(false);
    }
  });
});

describe("agentParams", () => {
  it("accepts an absent or ordinary params object", () => {
    expect(agentParams().parse(undefined)).toBeUndefined();
    expect(agentParams().parse({ select: ["ID"], filter: { action: "x" } })).toEqual({ select: ["ID"], filter: { action: "x" } });
  });

  it("names every reserved key it finds", () => {
    const res = agentParams().safeParse({ action: "a", sessid: "s", "mode[]": "m", ok: 1 });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.map((i) => i.message)).toEqual([
        '"action" is fixed by the operation and cannot be set through params',
        '"sessid" is fixed by the operation and cannot be set through params',
        '"mode[]" is fixed by the operation and cannot be set through params',
      ]);
    }
  });
});
