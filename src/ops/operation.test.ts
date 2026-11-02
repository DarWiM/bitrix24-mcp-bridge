import { describe, it, expect } from "bun:test";
import { agentParams } from "./operation.js";

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
