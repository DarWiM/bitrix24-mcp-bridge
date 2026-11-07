import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { MAX_BATCH, forEachTask, forEachTaskVetted, taskIdsArg } from "./batch.js";
import { BUDGET_TIMEOUT_MS } from "./operation.js";

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

  it("keeps its own taskId and ok even when the operation's fields carry those keys", async () => {
    const batch = await forEachTask([5], async () => ({ taskId: 99, ok: false, moved: true }));

    expect(batch.results).toEqual([{ taskId: 5, ok: true, moved: true }]);
    expect(Object.keys(batch.results[0])).toEqual(["taskId", "ok", "moved"]);
  });

  it("stops starting tasks once less than 30 s of the budget remain, awaits the running one and marks the rest", async () => {
    let clock = 1_000;
    const seen: number[] = [];

    // Budget 40 s: a task may start while under 10 s have passed; each one takes 6 s.
    const batch = await forEachTask(
      [1, 2, 3, 4],
      async (taskId) => {
        seen.push(taskId);
        clock += 6_000;
        return { done: true };
      },
      { budgetMs: 40_000, now: () => clock },
    );

    const skipped = "не выполнено: истекло время пакета — перечитайте состояние и повторите только эти задачи";
    expect(seen).toEqual([1, 2]);
    expect(batch.results).toEqual([
      { taskId: 1, ok: true, done: true },
      { taskId: 2, ok: true, done: true },
      { taskId: 3, ok: false, error: skipped },
      { taskId: 4, ok: false, error: skipped },
    ]);
  });

  it("keeps as much room as the slowest task so far once one took longer than 30 s", async () => {
    let clock = 0;
    const seen: number[] = [];

    // Budget 120 s; the first task takes 50 s, the second 20 s. The second starts with 70 s left, over
    // the 50 s the first took; the third would start with 50 s left — enough for a 30 s reserve, not
    // for another task as slow as the first.
    const batch = await forEachTask(
      [1, 2, 3],
      async (taskId) => {
        seen.push(taskId);
        clock += taskId === 1 ? 50_000 : 20_000;
        return {};
      },
      { budgetMs: 120_000, now: () => clock },
    );

    expect(seen).toEqual([1, 2]);
    expect(batch.results[2]).toMatchObject({ taskId: 3, ok: false, error: expect.stringContaining("истекло время пакета") });
  });

  it("counts a failed task's duration too", async () => {
    let clock = 0;
    const seen: number[] = [];

    const batch = await forEachTask(
      [1, 2],
      async (taskId) => {
        seen.push(taskId);
        clock += 70_000;
        throw new Error("timeout");
      },
      { budgetMs: 130_000, now: () => clock },
    );

    // 60 s left after the first one: over 30 s, but not over the 70 s it took.
    expect(seen).toEqual([1]);
    expect(batch.results[1]).toMatchObject({ taskId: 2, ok: false, error: expect.stringContaining("истекло время пакета") });
  });

  it("plans against the client's long budget by default", async () => {
    let clock = 0;
    const seen: number[] = [];

    const batch = await forEachTask(
      [1, 2],
      async (taskId) => {
        seen.push(taskId);
        clock = BUDGET_TIMEOUT_MS.long - 30_000;
        return {};
      },
      { now: () => clock },
    );

    expect(seen).toEqual([1]);
    expect(batch.results[1]).toMatchObject({ taskId: 2, ok: false });
  });

  it("turns a non-Error rejection into a string error", async () => {
    const batch = await forEachTask([5], async () => {
      throw "boom";
    });

    expect(batch.results).toEqual([{ taskId: 5, ok: false, error: "boom" }]);
  });
});

describe("forEachTaskVetted", () => {
  it("prepares every task before applying any, vets what was prepared and keeps a failed task's error", async () => {
    const steps: string[] = [];
    let vetted: number[] = [];

    const batch = await forEachTaskVetted([1, 2, 3], {
      prepare: async (taskId) => {
        steps.push(`prepare ${taskId}`);
        if (taskId === 2) throw new Error("задача 2 не в проекте");
        return taskId * 10;
      },
      vet: (prepared) => {
        vetted = prepared;
      },
      apply: async (taskId, prepared) => {
        steps.push(`apply ${taskId}`);
        return { prepared };
      },
    });

    expect(steps).toEqual(["prepare 1", "prepare 2", "prepare 3", "apply 1", "apply 3"]);
    expect(vetted).toEqual([10, 30]);
    expect(batch.results).toEqual([
      { taskId: 1, ok: true, prepared: 10 },
      { taskId: 2, ok: false, error: "задача 2 не в проекте" },
      { taskId: 3, ok: true, prepared: 30 },
    ]);
  });

  it("applies nothing when the vet refuses", async () => {
    const applied: number[] = [];

    const run = forEachTaskVetted([1, 2], {
      prepare: async (taskId) => taskId,
      vet: () => {
        throw new Error("refused");
      },
      apply: async (taskId) => {
        applied.push(taskId);
        return {};
      },
    });

    await expect(run).rejects.toThrow("refused");
    expect(applied).toEqual([]);
  });

  it("gives the second pass only what the first one left of the budget", async () => {
    let clock = 0;
    const applied: number[] = [];

    // Budget 40 s; preparing takes 6 s per task, so the writes have 28 s — under the 30 s reserve.
    const batch = await forEachTaskVetted(
      [1, 2],
      {
        prepare: async () => {
          clock += 6_000;
        },
        vet: () => {},
        apply: async (taskId) => {
          applied.push(taskId);
          return {};
        },
      },
      { budgetMs: 40_000, now: () => clock },
    );

    expect(applied).toEqual([]);
    expect(batch.results).toEqual([
      { taskId: 1, ok: false, error: expect.stringContaining("истекло время пакета") },
      { taskId: 2, ok: false, error: expect.stringContaining("истекло время пакета") },
    ]);
  });
});

describe("forEachTaskVetted pacing", () => {
  it("keeps a failed read's own error when the writes run out of time, in input order", async () => {
    let clock = 0;

    // Budget 40 s; the reads take 6 s each, so no write fits — but task 2 never got that far.
    const batch = await forEachTaskVetted(
      [1, 2, 3],
      {
        prepare: async (taskId) => {
          clock += 6_000;
          if (taskId === 2) throw new Error("задача 2 не найдена или нет доступа (удалена или скрыта от тебя)");
        },
        vet: () => {},
        apply: async () => ({}),
      },
      { budgetMs: 40_000, now: () => clock },
    );

    expect(batch.results).toEqual([
      { taskId: 1, ok: false, error: expect.stringContaining("истекло время пакета") },
      { taskId: 2, ok: false, error: "задача 2 не найдена или нет доступа (удалена или скрыта от тебя)" },
      { taskId: 3, ok: false, error: expect.stringContaining("истекло время пакета") },
    ]);
  });

  it("keeps the slowest read of the first pass as the room a write needs", async () => {
    let clock = 0;
    const applied: number[] = [];

    // Budget 150 s; the read takes 90 s, leaving 60 s — over a 30 s reserve, not over 90 s.
    const batch = await forEachTaskVetted(
      [1],
      {
        prepare: async () => {
          clock += 90_000;
        },
        vet: () => {},
        apply: async (taskId) => {
          applied.push(taskId);
          return {};
        },
      },
      { budgetMs: 150_000, now: () => clock },
    );

    expect(applied).toEqual([]);
    expect(batch.results[0]).toMatchObject({ taskId: 1, ok: false, error: expect.stringContaining("истекло время пакета") });
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
