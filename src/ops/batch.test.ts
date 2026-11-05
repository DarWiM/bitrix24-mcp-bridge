import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { MAX_BATCH, forEachTask, taskIdsArg } from "./batch.js";

describe("forEachTask", () => {
  it("runs every task in input order, one at a time, and reports each as ok with its fields", async () => {
    const seen: number[] = [];
    let running = 0;

    const batch = await forEachTask([3, 1, 2], async (taskId) => {
      running++;
      expect(running).toBe(1);
      await Promise.resolve();
      seen.push(taskId);
      running--;
      return { doubled: taskId * 2 };
    });

    expect(seen).toEqual([3, 1, 2]);
    expect(batch).toEqual({
      results: [
        { taskId: 3, ok: true, doubled: 6 },
        { taskId: 1, ok: true, doubled: 2 },
        { taskId: 2, ok: true, doubled: 4 },
      ],
    });
  });

  it("records a failing task with its error and still runs the rest", async () => {
    const seen: number[] = [];

    const batch = await forEachTask([1, 2, 3], async (taskId) => {
      seen.push(taskId);
      if (taskId === 2) throw new Error("задача 2 не на доске");
      return { done: true };
    });

    expect(seen).toEqual([1, 2, 3]);
    expect(batch.results).toEqual([
      { taskId: 1, ok: true, done: true },
      { taskId: 2, ok: false, error: "задача 2 не на доске" },
      { taskId: 3, ok: true, done: true },
    ]);
  });

  it("turns a non-Error rejection into a string error", async () => {
    const batch = await forEachTask([5], async () => {
      throw "boom";
    });

    expect(batch.results).toEqual([{ taskId: 5, ok: false, error: "boom" }]);
  });
});

describe("taskIdsArg", () => {
  const schema = z.object({ taskIds: taskIdsArg() });

  it("accepts numbers and digit strings and yields numbers", () => {
    expect(schema.parse({ taskIds: [42, "43"] })).toEqual({ taskIds: [42, 43] });
  });

  for (const [title, taskIds] of [
    ["an empty list", []],
    [`more than ${MAX_BATCH} ids`, Array.from({ length: MAX_BATCH + 1 }, (_, i) => i + 1)],
    ["a non-numeric id", ["42a"]],
    ["a single id instead of a list", 42],
  ] as const) {
    it(`rejects ${title}`, () => {
      expect(schema.safeParse({ taskIds }).success).toBe(false);
    });
  }

  it("rejects a duplicated id, also when one copy is a digit string, and names it", () => {
    const parsed = schema.safeParse({ taskIds: [42, 7, "42"] });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toEqual(["task 42 is listed more than once"]);
  });

  it(`accepts exactly ${MAX_BATCH} ids`, () => {
    expect(schema.safeParse({ taskIds: Array.from({ length: MAX_BATCH }, (_, i) => i + 1) }).success).toBe(true);
  });
});
