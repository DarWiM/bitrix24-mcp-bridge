import { describe, it, expect, mock } from "bun:test";
import type { CallTarget, DownloadResult } from "../../shared/wire.js";
import { OpInputError, OpRefusedError, type OpContext, type Operation } from "./operation.js";
import { createRegistry, runOperation } from "./registry.js";
import { OPERATIONS } from "./index.js";

const AJAX = "/bitrix/services/main/ajax.php";

type CallFn = (target: CallTarget, portal?: string) => Promise<unknown>;

function fakeCtx(callFn: CallFn = async () => ({ result: true })) {
  const call = mock(callFn);
  const callBinary = mock(async (_target: CallTarget, _dest: string): Promise<DownloadResult> => {
    throw new Error("unexpected download");
  });
  const ctx: OpContext = {
    portal: "d",
    origin: "https://d.bitrix24.ru",
    origins: { d: "https://d.bitrix24.ru" },
    downloadsDir: "/tmp/br24-unused",
    call,
    callBinary,
  };
  return { ctx, call };
}

// Replies in order, one per request — the shape of a multi-request operation's conversation.
function replies(...pages: unknown[]): CallFn {
  let i = 0;
  return async () => {
    if (i >= pages.length) throw new Error("no more replies");
    const page = pages[i++];
    if (page instanceof Error) throw page;
    return page;
  };
}

function op(name: string): Operation {
  const found = OPERATIONS.find((o) => o.name === name);
  if (!found) throw new Error(`no operation ${name}`);
  return found;
}

const rest = (endpoint: string, params: Record<string, unknown>): CallTarget =>
  ({ endpoint, action: null, method: "POST", bodyType: "form", responseType: "json", params });
const json = (action: string, params: Record<string, unknown>): CallTarget =>
  ({ endpoint: AJAX, action, method: "POST", bodyType: "json", responseType: "json", params });

const MUTATING = ["task_description_replace", "task_tags", "task_checklist_edit", "task_plan"];

describe("content operations in OPERATIONS", () => {
  it("registers task_checklist as a read and the others as mutating, none taking agent params", () => {
    expect(op("task_checklist").mutating).toBe(false);
    for (const name of MUTATING) expect(op(name).mutating).toBe(true);
    for (const name of [...MUTATING, "task_checklist"]) expect(Object.keys(op(name).input)).not.toContain("params");
  });

  it("refuses every mutating one before any request when mutations are off", async () => {
    const { ctx, call } = fakeCtx();
    const reg = createRegistry(OPERATIONS);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["task_description_replace", { taskId: 1, find: "a", replace: "b" }],
      ["task_tags", { taskIds: [1], add: ["x"] }],
      ["task_checklist_edit", { taskId: 1, add: ["x"] }],
      ["task_plan", { taskId: 1, start: null, end: null }],
    ];
    for (const [name, args] of calls) {
      await expect(runOperation(reg, name, args, ctx, { allowMutations: false })).rejects.toThrow(OpRefusedError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

const description = (text: string | null) => ({ status: "success", data: { id: 42, description: text } });

describe("task_description_replace", () => {
  it("replaces the single match and keeps everything around it byte for byte", async () => {
    const current = "Шаг 1\r\n[disk file id=22081]\n[b]Статус:[/b] в работе  \n\n";
    const { ctx, call } = fakeCtx(replies(description(current), { result: { task: {} } }));

    const result = await op("task_description_replace").execute(ctx, { taskId: "42", find: "в работе", replace: "готово $& $1" });

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0]).toEqual(json("tasks.v2.Task.get", { task: { id: 42 } }));
    const expected = "Шаг 1\r\n[disk file id=22081]\n[b]Статус:[/b] готово $& $1  \n\n";
    expect(call.mock.calls[1][0]).toEqual(rest("/rest/tasks.task.update.json", { taskId: 42, fields: { DESCRIPTION: expected } }));
    expect(result).toEqual({ taskId: 42, replaced: 1, length: expected.length });
  });

  it("refuses an ambiguous match without all and names the count", async () => {
    const { ctx, call } = fakeCtx(replies(description("[*]todo\n[*]todo\n[*]todo")));

    await expect(op("task_description_replace").execute(ctx, { taskId: 42, find: "todo", replace: "done" })).rejects.toThrow(/3/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("counts overlapping matches: \"aa\" in \"aaa\" is ambiguous", async () => {
    const { ctx, call } = fakeCtx(replies(description("aaa")));

    await expect(op("task_description_replace").execute(ctx, { taskId: 42, find: "aa", replace: "b" })).rejects.toThrow(/2 раз/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("replaces non-overlapping matches left to right with all: true", async () => {
    const { ctx, call } = fakeCtx(replies(description("aaa"), { result: true }));

    const result = await op("task_description_replace").execute(ctx, { taskId: 42, find: "aa", replace: "b", all: true });

    expect(call.mock.calls[1][0].params).toEqual({ taskId: 42, fields: { DESCRIPTION: "ba" } });
    expect(result).toEqual({ taskId: 42, replaced: 1, length: 2 });
  });

  it("replaces every match with all: true", async () => {
    const { ctx, call } = fakeCtx(replies(description("[*]todo\n[*]todo"), { result: true }));

    const result = await op("task_description_replace").execute(ctx, { taskId: 42, find: "todo", replace: "", all: true });

    expect(call.mock.calls[1][0].params).toEqual({ taskId: 42, fields: { DESCRIPTION: "[*]\n[*]" } });
    expect(result).toEqual({ taskId: 42, replaced: 2, length: 7 });
  });

  for (const current of ["другой текст", "", null]) {
    it(`fails without writing when there is no match in ${JSON.stringify(current)}`, async () => {
      const { ctx, call } = fakeCtx(replies(description(current)));

      await expect(op("task_description_replace").execute(ctx, { taskId: 42, find: "todo", replace: "x" })).rejects.toThrow(/не найден/);
      expect(call).toHaveBeenCalledTimes(1);
    });
  }

  it("does not write when the read fails or comes back in an unexpected shape", async () => {
    for (const reply of [new Error("timeout"), { status: "success", data: [] }]) {
      const { ctx, call } = fakeCtx(replies(reply));

      await expect(op("task_description_replace").execute(ctx, { taskId: 42, find: "a", replace: "b" })).rejects.toThrow();
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("does not write a result over 100 000 characters", async () => {
    const { ctx, call } = fakeCtx(replies(description("ab")));

    await expect(
      op("task_description_replace").execute(ctx, { taskId: 42, find: "a", replace: "x".repeat(100_000) }),
    ).rejects.toThrow(/100000/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty find before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("task_description_replace").execute(ctx, { taskId: 42, find: "", replace: "x" })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});

// The recorded v2 shape: each tag carries its owner, group and task besides the name.
const tags = (...names: string[]) => ({
  status: "success",
  data: { id: 42, tags: names.map((name, i) => ({ id: i + 1, name, owner: null, group: { id: 15 }, task: { id: 42 } })) },
});

describe("task_tags", () => {
  it("reads each task's tags, writes the edited list through the v2 update and re-reads it", async () => {
    const { ctx, call } = fakeCtx(replies(tags("backend", "Срочно"), { status: "success", data: {} }, tags("backend", "релиз")));

    const result = await op("task_tags").execute(ctx, { taskIds: ["42"], add: ["релиз", "Backend"], remove: ["срочно"] });

    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[0][0]).toEqual(json("tasks.v2.Task.get", { task: { id: 42 } }));
    expect(call.mock.calls[1][0]).toEqual(json("tasks.v2.Task.update", { task: { id: 42, tags: [{ name: "backend" }, { name: "релиз" }] } }));
    expect(result).toEqual({ results: [{ taskId: 42, ok: true, tags: ["backend", "релиз"], changed: true }] });
  });

  it("clears the list with an empty array", async () => {
    const { ctx, call } = fakeCtx(replies(tags("a"), { status: "success" }, tags()));

    const result = await op("task_tags").execute(ctx, { taskIds: [42], remove: ["A"] });

    expect(call.mock.calls[1][0].params).toEqual({ task: { id: 42, tags: [] } });
    expect(result).toEqual({ results: [{ taskId: 42, ok: true, tags: [], changed: true }] });
  });

  it("writes nothing when the list would not change", async () => {
    const { ctx, call } = fakeCtx(replies(tags("a", "b")));

    const result = await op("task_tags").execute(ctx, { taskIds: [42], add: ["A"], remove: ["c"] });

    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ results: [{ taskId: 42, ok: true, tags: ["a", "b"], changed: false }] });
  });

  it("does not write a task whose tags could not be read, and goes on with the next one", async () => {
    const { ctx, call } = fakeCtx(replies({ status: "success", data: { id: 1 } }, tags(), { status: "success" }, tags("x")));

    const result = await op("task_tags").execute(ctx, { taskIds: [1, 2], add: ["x"] });

    expect(call).toHaveBeenCalledTimes(4);
    expect(call.mock.calls[1][0]).toEqual(json("tasks.v2.Task.get", { task: { id: 2 } }));
    expect(result).toEqual({
      results: [
        { taskId: 1, ok: false, error: expect.stringMatching(/unexpected shape/) },
        { taskId: 2, ok: true, tags: ["x"], changed: true },
      ],
    });
  });

  it("fails the task when the re-read list differs from the written one", async () => {
    const { ctx } = fakeCtx(replies(tags("a"), { status: "success" }, tags("a")));

    const result = await op("task_tags").execute(ctx, { taskIds: [42], add: ["b"] });

    expect(result).toEqual({ results: [{ taskId: 42, ok: false, error: expect.stringMatching(/Bitrix не применил.*b/) }] });
  });

  it("rejects no changes or a tag in both add and remove before any request", async () => {
    const { ctx, call } = fakeCtx();

    for (const args of [{ taskIds: [42] }, { taskIds: [42], add: [] }, { taskIds: [42], add: ["Релиз"], remove: ["релиз"] }, { taskIds: [42], add: ["  "] }]) {
      await expect(op("task_tags").execute(ctx, args)).rejects.toThrow(OpInputError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

const checklist = (...items: Array<[id: string, parentId: string, title: string, complete: "Y" | "N"]>) => ({
  result: items.map(([ID, PARENT_ID, TITLE, IS_COMPLETE]) => ({ ID, PARENT_ID, TITLE, IS_COMPLETE, SORT_INDEX: "0", TASK_ID: "42" })),
});

describe("task_checklist", () => {
  it("returns the flat list of items", async () => {
    const { ctx, call } = fakeCtx(replies(checklist(["10", "0", "BX_CHECKLIST_1", "N"], ["11", "10", "Тесты", "Y"])));

    const result = await op("task_checklist").execute(ctx, { taskId: "42" });

    expect(call.mock.calls[0][0]).toEqual(rest("/rest/task.checklistitem.getlist.json", { TASKID: 42 }));
    expect(result).toEqual({
      taskId: 42,
      items: [
        { id: 10, parentId: 0, title: "BX_CHECKLIST_1", done: false },
        { id: 11, parentId: 10, title: "Тесты", done: true },
      ],
    });
  });
});

describe("task_checklist_edit", () => {
  const before = checklist(["10", "0", "BX_CHECKLIST_1", "N"], ["11", "10", "Тесты", "N"], ["12", "10", "Ревью", "Y"], ["13", "10", "Лишнее", "N"]);

  it("checks the ids, applies add / rename / complete / reopen / remove in order and returns the re-read list", async () => {
    const after = checklist(["10", "0", "BX_CHECKLIST_1", "N"], ["11", "10", "Тесты пройдены", "Y"], ["12", "10", "Ревью", "N"], ["20", "10", "Деплой", "N"]);
    const { ctx, call } = fakeCtx(
      replies(before, { result: "20" }, { result: null }, { result: true }, { result: true }, { result: true }, after),
    );

    const result = await op("task_checklist_edit").execute(ctx, {
      taskId: 42,
      add: ["Деплой"],
      rename: [{ itemId: "11", title: "Тесты пройдены" }],
      complete: [11],
      reopen: [12],
      remove: [13],
    });

    expect(call.mock.calls.map(([t]) => t)).toEqual([
      rest("/rest/task.checklistitem.getlist.json", { TASKID: 42 }),
      rest("/rest/task.checklistitem.add.json", { TASKID: 42, FIELDS: { TITLE: "Деплой" } }),
      rest("/rest/task.checklistitem.update.json", { TASKID: 42, ITEMID: 11, FIELDS: { TITLE: "Тесты пройдены" } }),
      rest("/rest/task.checklistitem.complete.json", { TASKID: 42, ITEMID: 11 }),
      rest("/rest/task.checklistitem.renew.json", { TASKID: 42, ITEMID: 12 }),
      rest("/rest/task.checklistitem.delete.json", { TASKID: 42, ITEMID: 13 }),
      rest("/rest/task.checklistitem.getlist.json", { TASKID: 42 }),
    ]);
    expect(result).toEqual({
      taskId: 42,
      added: [20],
      items: [
        { id: 10, parentId: 0, title: "BX_CHECKLIST_1", done: false },
        { id: 11, parentId: 10, title: "Тесты пройдены", done: true },
        { id: 12, parentId: 10, title: "Ревью", done: false },
        { id: 20, parentId: 10, title: "Деплой", done: false },
      ],
    });
  });

  it("changes nothing when an item is not in the task's checklist", async () => {
    const { ctx, call } = fakeCtx(replies(before));

    await expect(op("task_checklist_edit").execute(ctx, { taskId: 42, add: ["x"], complete: [99] })).rejects.toThrow(/99/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports what was already done when a step fails midway", async () => {
    const { ctx, call } = fakeCtx(replies(before, { result: true }, new Error("ACCESS_DENIED")));

    const err = await op("task_checklist_edit").execute(ctx, { taskId: 42, complete: [11, 13] }).catch((e: unknown) => e);

    expect(call).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/ACCESS_DENIED/);
    expect(String(err)).toMatch(/отметить 11/);
    expect(String(err)).toMatch(/bitrix_task_checklist/);
  });

  it("reports an add whose answer is not recognised as sent, not as failed", async () => {
    const { ctx, call } = fakeCtx(replies(before, { result: { unexpected: true } }));

    const err = await op("task_checklist_edit").execute(ctx, { taskId: 42, add: ["Деплой", "Релиз"] }).catch((e: unknown) => e);

    expect(call).toHaveBeenCalledTimes(2);
    expect(String(err)).toMatch(/добавить «Деплой»: отправлено, ответ не распознан/);
    expect(String(err)).not.toMatch(/не выполнено/);
    expect(String(err)).toMatch(/перечитай чек-лист.*перед повтором/);
  });

  it("does not delete or report items that went away with their removed group", async () => {
    const after = checklist(["14", "0", "Другая группа", "N"]);
    const withSecondGroup = { result: [...before.result, ...checklist(["14", "0", "Другая группа", "N"]).result] };
    const { ctx, call } = fakeCtx(replies(withSecondGroup, { result: "21" }, { result: true }, { result: true }, after));

    const result = await op("task_checklist_edit").execute(ctx, { taskId: 42, add: ["Новый"], complete: [11], remove: [10, 13] });

    expect(call.mock.calls.map(([t]) => t.endpoint)).toEqual([
      "/rest/task.checklistitem.getlist.json",
      "/rest/task.checklistitem.add.json",
      "/rest/task.checklistitem.complete.json",
      "/rest/task.checklistitem.delete.json",
      "/rest/task.checklistitem.getlist.json",
    ]);
    expect(call.mock.calls[3][0].params).toEqual({ TASKID: 42, ITEMID: 10 });
    expect(result).toEqual({ taskId: 42, added: [21], items: [{ id: 14, parentId: 0, title: "Другая группа", done: false }] });
  });

  it("still reports an item of a removed group that Bitrix kept", async () => {
    const { ctx } = fakeCtx(replies(before, { result: true }, checklist(["13", "10", "Лишнее", "N"])));

    await expect(op("task_checklist_edit").execute(ctx, { taskId: 42, remove: [10, 13] })).rejects.toThrow(/Bitrix не применил: удалить 13/);
  });

  it("fails when a complete / reopen / remove answers anything but true", async () => {
    const { ctx } = fakeCtx(replies(before, { result: false }));

    await expect(op("task_checklist_edit").execute(ctx, { taskId: 42, remove: [13] })).rejects.toThrow(/удалить 13/);
  });

  it("fails when the re-read list does not show the change", async () => {
    const { ctx } = fakeCtx(replies(before, { result: true }, before));

    await expect(op("task_checklist_edit").execute(ctx, { taskId: 42, complete: [11] })).rejects.toThrow(/Bitrix не применил.*11/);
  });

  it("rejects no changes or conflicting actions on one item before any request", async () => {
    const { ctx, call } = fakeCtx();

    for (const args of [
      { taskId: 42 },
      { taskId: 42, add: [] },
      { taskId: 42, complete: [11], reopen: [11] },
      { taskId: 42, rename: [{ itemId: 11, title: "x" }], remove: ["11"] },
      { taskId: 42, complete: [11], remove: [11] },
      { taskId: 42, complete: [11, "11"] },
      { taskId: 42, rename: [{ itemId: 11, title: "x" }, { itemId: 11, title: "y" }] },
      { taskId: 42, add: [" "] },
      { taskId: 42, add: Array.from({ length: 30 }, (_, i) => `п${i}`), complete: Array.from({ length: 21 }, (_, i) => i + 1) },
    ]) {
      await expect(op("task_checklist_edit").execute(ctx, args)).rejects.toThrow(OpInputError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_plan", () => {
  const PLAN = "tasks.v2.Task.Plan.update";
  const plan = (start: string | null, end: string | null) => ({
    task: {
      id: 42,
      startPlanTs: start === null ? 0 : Date.parse(start) / 1000,
      endPlanTs: end === null ? 0 : Date.parse(end) / 1000,
      matchesWorkTime: false,
      matchesSubTasksTime: false,
    },
  });
  // What v2 Task.get holds after the write: unset dates come back as null.
  const stored = (start: string | null, end: string | null) => ({
    status: "success",
    data: {
      id: 42,
      startPlanTs: start === null ? null : Date.parse(start) / 1000,
      endPlanTs: end === null ? null : Date.parse(end) / 1000,
      deadlineTs: null,
    },
  });

  it("writes both dates in unix seconds without reading the task first, then re-reads them", async () => {
    const { ctx, call } = fakeCtx(replies({ status: "success", data: {} }, stored("2026-11-10T06:00:00Z", "2026-11-12T18:00:00Z")));

    const result = await op("task_plan").execute(ctx, { taskId: "42", start: "2026-11-10T09:00:00+03:00", end: "2026-11-12T18:00:00Z" });

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0]).toEqual(json(PLAN, plan("2026-11-10T06:00:00Z", "2026-11-12T18:00:00Z")));
    expect(call.mock.calls[1][0]).toEqual(json("tasks.v2.Task.get", { task: { id: 42 } }));
    expect(result).toEqual({ taskId: 42, start: "2026-11-10T06:00:00.000Z", end: "2026-11-12T18:00:00.000Z" });
  });

  it("fails when the re-read dates differ from the written ones", async () => {
    const { ctx } = fakeCtx(replies({ status: "success" }, stored("2026-11-10T00:00:00Z", null)));

    await expect(
      op("task_plan").execute(ctx, { taskId: 42, start: "2026-11-10T00:00:00Z", end: "2026-11-12T00:00:00Z" }),
    ).rejects.toThrow(/даты другие.*end нет/);
  });

  it("says the write was sent when the re-read fails", async () => {
    const { ctx } = fakeCtx(replies({ status: "success" }, new Error("timeout")));

    await expect(op("task_plan").execute(ctx, { taskId: 42, start: null, end: null })).rejects.toThrow(/запись отправлена.*timeout/);
  });

  it("clears a date passed as null", async () => {
    const { ctx, call } = fakeCtx(replies({ status: "success" }, stored(null, null)));

    const result = await op("task_plan").execute(ctx, { taskId: 42, start: null, end: null });

    expect(call.mock.calls[0][0]).toEqual(json(PLAN, plan(null, null)));
    expect(result).toEqual({ taskId: 42, start: null, end: null });
  });

  it("keeps the current value of a date that is not passed", async () => {
    const current = { status: "success", data: { id: 42, startPlanTs: Date.parse("2026-11-01T00:00:00Z") / 1000, endPlanTs: null } };
    const { ctx, call } = fakeCtx(replies(current, { status: "success" }, stored("2026-11-01T00:00:00Z", "2026-11-20T00:00:00Z")));

    const result = await op("task_plan").execute(ctx, { taskId: 42, end: "2026-11-20T00:00:00Z" });

    expect(call.mock.calls[0][0]).toEqual(json("tasks.v2.Task.get", { task: { id: 42 } }));
    expect(call.mock.calls[1][0]).toEqual(json(PLAN, plan("2026-11-01T00:00:00Z", "2026-11-20T00:00:00Z")));
    expect(result).toEqual({ taskId: 42, start: "2026-11-01T00:00:00.000Z", end: "2026-11-20T00:00:00.000Z" });
  });

  it("treats stored null dates as unset on a partial update", async () => {
    const { ctx, call } = fakeCtx(replies(stored(null, null), { status: "success" }, stored("2026-11-10T00:00:00Z", null)));

    const result = await op("task_plan").execute(ctx, { taskId: 42, start: "2026-11-10T00:00:00Z" });

    expect(call.mock.calls[1][0]).toEqual(json(PLAN, plan("2026-11-10T00:00:00Z", null)));
    expect(result).toEqual({ taskId: 42, start: "2026-11-10T00:00:00.000Z", end: null });
  });

  it("does not write when the current dates cannot be read", async () => {
    const { ctx, call } = fakeCtx(replies({ status: "success", data: { id: 42 } }));

    await expect(op("task_plan").execute(ctx, { taskId: 42, start: "2026-11-01T00:00:00Z" })).rejects.toThrow(/unexpected shape/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not write a start after the end, including one read from the task", async () => {
    const current = { status: "success", data: { id: 42, startPlanTs: Date.parse("2026-12-01T00:00:00Z") / 1000, endPlanTs: 0 } };
    const { ctx, call } = fakeCtx(replies(current));

    await expect(op("task_plan").execute(ctx, { taskId: 42, end: "2026-11-01T00:00:00Z" })).rejects.toThrow(/позже/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects no dates, a date without an offset, or a start after the end before any request", async () => {
    const { ctx, call } = fakeCtx();

    for (const args of [
      { taskId: 42 },
      { taskId: 42, start: "2026-11-10" },
      { taskId: 42, start: "2026-11-10T09:00:00" },
      { taskId: 42, start: "1970-01-01T00:00:00Z" },
      { taskId: 42, end: "1969-12-31T23:00:00Z" },
      { taskId: 42, start: "2026-11-12T00:00:00Z", end: "2026-11-10T00:00:00Z" },
    ]) {
      await expect(op("task_plan").execute(ctx, args)).rejects.toThrow(OpInputError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});
