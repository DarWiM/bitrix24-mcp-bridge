import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { defineOperation, idArg, OpInputError, OpRefusedError, type OpContext } from "./operation.js";
import { createRegistry, runOperation } from "./registry.js";

const ctx: OpContext = {
  portal: "main",
  origin: "https://example.bitrix24.test",
  downloadsDir: "/tmp/downloads",
  call: async () => ({}),
  callBinary: async () => ({ path: "/tmp/x", bytes: 0, contentType: "", fileName: null }),
};

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("expected promise to reject");
}

function makeOp(mutating: boolean) {
  const calls: unknown[] = [];
  const op = defineOperation({
    name: mutating ? "task.write" : "task.read",
    description: "test op",
    mutating,
    input: { taskId: idArg },
    async run(_ctx, args) {
      calls.push(args);
      return { ok: true };
    },
  });
  return { op, calls };
}

describe("operation registry", () => {
  it("runs a read operation with parsed args", async () => {
    const { op, calls } = makeOp(false);
    const reg = createRegistry([op]);
    await runOperation(reg, "task.read", { taskId: "31861" }, ctx, { allowMutations: false });
    expect(calls).toEqual([{ taskId: 31861 }]);
  });

  it("strips unknown keys", async () => {
    const { op, calls } = makeOp(false);
    const reg = createRegistry([op]);
    await runOperation(reg, "task.read", { taskId: 1, extra: "x" }, ctx, { allowMutations: false });
    expect(calls).toEqual([{ taskId: 1 }]);
  });

  it("rejects invalid args with field path", async () => {
    const { op, calls } = makeOp(false);
    const reg = createRegistry([op]);
    const err = await rejection(runOperation(reg, "task.read", { taskId: "abc" }, ctx, { allowMutations: false }));
    expect(err).toBeInstanceOf(OpInputError);
    expect(err.message).toContain("taskId");
    expect(calls).toHaveLength(0);
  });

  it("refuses a mutating op when mutations are off", async () => {
    const { op, calls } = makeOp(true);
    const reg = createRegistry([op]);
    const err = await rejection(runOperation(reg, "task.write", { taskId: 1 }, ctx, { allowMutations: false }));
    expect(err).toBeInstanceOf(OpRefusedError);
    expect(err.message).toContain("mutations");
    expect(err.message).toContain("config.json");
    expect(calls).toHaveLength(0);
  });

  it("allows a mutating op when mutations are on", async () => {
    const { op, calls } = makeOp(true);
    const reg = createRegistry([op]);
    await runOperation(reg, "task.write", { taskId: 1 }, ctx, { allowMutations: true });
    expect(calls).toEqual([{ taskId: 1 }]);
  });

  it("refuses an unknown operation name", async () => {
    const reg = createRegistry([]);
    const err = await rejection(runOperation(reg, "nope", {}, ctx, { allowMutations: true }));
    expect(err).toBeInstanceOf(OpRefusedError);
    expect(err.message).toContain("unknown operation");
  });

  it("throws on duplicate operation names", () => {
    const { op } = makeOp(false);
    expect(() => createRegistry([op, op])).toThrow(/duplicate/);
  });

  it("exposes registered operations", () => {
    const { op } = makeOp(false);
    const reg = createRegistry([op]);
    expect(reg.get("task.read")).toBe(op);
    expect(reg.list()).toEqual([op]);
    expect(z.object(op.input).safeParse({ taskId: 5 }).success).toBe(true);
  });
});
