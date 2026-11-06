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

const MUTATING = ["task_related_edit", "task_parent", "task_gantt_link"];

describe("relation operations in OPERATIONS", () => {
  it("registers them as mutating, under the long budget, none taking agent params", () => {
    for (const name of MUTATING) {
      expect(op(name).mutating).toBe(true);
      expect(op(name).budget).toBe("long");
      expect(Object.keys(op(name).input)).not.toContain("params");
    }
  });

  it("refuses every one before any request when mutations are off", async () => {
    const { ctx, call } = fakeCtx();
    const reg = createRegistry(OPERATIONS);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["task_related_edit", { taskId: 1, add: [2] }],
      ["task_parent", { taskId: 1, parentId: null }],
      ["task_gantt_link", { taskId: 1, dependentId: 2 }],
    ];
    for (const [name, args] of calls) {
      await expect(runOperation(reg, name, args, ctx, { allowMutations: false })).rejects.toThrow(OpRefusedError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

const related = (...ids: number[]) => ({
  status: "success",
  data: { tasks: ids.map((id) => ({ id, title: `Задача ${id}` })), ids, statuses: {} },
});
const relatedList = (taskId: number) =>
  json("tasks.v2.Task.Relation.Related.list", { taskId, withIds: true, withCompleted: true, withSubTasks: false, navigation: { size: 100 } });
const done = (...ids: number[]) => ({ status: "success", data: Object.fromEntries(ids.map((id) => [String(id), true])) });

describe("task_related_edit", () => {
  it("adds only the missing tasks, removes only the related ones, and re-reads the list", async () => {
    const { ctx, call } = fakeCtx(replies(related(5, 6), done(7), done(6), related(5, 7)));

    const result = await op("task_related_edit").execute(ctx, { taskId: "42", add: [5, "7"], remove: [6, 8] });

    expect(call).toHaveBeenCalledTimes(4);
    expect(call.mock.calls[0][0]).toEqual(relatedList(42));
    expect(call.mock.calls[1][0]).toEqual(json("tasks.v2.Task.Relation.Related.add", { taskId: 42, tasks: [{ id: 7 }], noOverride: false }));
    expect(call.mock.calls[2][0]).toEqual(json("tasks.v2.Task.Relation.Related.delete", { taskId: 42, tasks: [{ id: 6 }] }));
    expect(call.mock.calls[3][0]).toEqual(relatedList(42));
    expect(result).toEqual({ taskId: 42, related: [5, 7], changed: true });
  });

  it("only removes when nothing is to be added", async () => {
    const { ctx, call } = fakeCtx(replies(related(5), done(5), related()));

    const result = await op("task_related_edit").execute(ctx, { taskId: 42, remove: [5] });

    expect(call.mock.calls[1][0]).toEqual(json("tasks.v2.Task.Relation.Related.delete", { taskId: 42, tasks: [{ id: 5 }] }));
    expect(result).toEqual({ taskId: 42, related: [], changed: true });
  });

  it("writes nothing when every task is already where it was asked to be", async () => {
    const { ctx, call } = fakeCtx(replies(related(5)));

    const result = await op("task_related_edit").execute(ctx, { taskId: 42, add: [5], remove: [6] });

    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ taskId: 42, related: [5], changed: false });
  });

  it("does not write when the list cannot be read or comes back in an unexpected shape", async () => {
    for (const reply of [new Error("timeout"), { status: "success", data: { tasks: [] } }]) {
      const { ctx, call } = fakeCtx(replies(reply));

      await expect(op("task_related_edit").execute(ctx, { taskId: 42, add: [5] })).rejects.toThrow();
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("fails when the re-read list shows Bitrix did not apply a change", async () => {
    const { ctx } = fakeCtx(replies(related(6), done(5), done(6), related(6)));

    await expect(op("task_related_edit").execute(ctx, { taskId: 42, add: [5], remove: [6] })).rejects.toThrow(
      /не добавлены 5; не убраны 6/,
    );
  });

  it("fails when links the agent did not ask to remove are gone after the write", async () => {
    const { ctx } = fakeCtx(replies(related(5, 6), done(7), related(7)));

    await expect(op("task_related_edit").execute(ctx, { taskId: 42, add: [7] })).rejects.toThrow(
      /пропали без запроса 5, 6 \(до правки: 5, 6; сейчас: 7\)/,
    );
  });

  it("refuses a list as long as the page, which may be cut, without writing", async () => {
    const { ctx, call } = fakeCtx(replies(related(...Array.from({ length: 100 }, (_, i) => i + 100))));

    await expect(op("task_related_edit").execute(ctx, { taskId: 42, add: [5] })).rejects.toThrow(/100 или больше связанных/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("says the state is unknown when the add request fails", async () => {
    const { ctx, call } = fakeCtx(replies(related(6), new Error("timeout")));

    await expect(op("task_related_edit").execute(ctx, { taskId: 42, add: [5], remove: [6] })).rejects.toThrow(
      /добавить 5 не удалось: timeout — состояние связей неизвестно.*bitrix_task_related/,
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("says the additions went through when the removal then fails", async () => {
    const { ctx, call } = fakeCtx(replies(related(6), done(5), new Error("ACCESS_DENIED")));

    await expect(op("task_related_edit").execute(ctx, { taskId: 42, add: [5], remove: [6] })).rejects.toThrow(
      /добавлены 5.*ACCESS_DENIED — состояние связей неизвестно.*bitrix_task_related/,
    );
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("says the write was sent when the re-read fails", async () => {
    const { ctx } = fakeCtx(replies(related(), done(5), new Error("timeout")));

    await expect(op("task_related_edit").execute(ctx, { taskId: 42, add: [5] })).rejects.toThrow(/отправлен.*timeout/);
  });

  it("rejects no changes, a task in both lists or the task itself before any request", async () => {
    const { ctx, call } = fakeCtx();

    for (const args of [{ taskId: 42 }, { taskId: 42, add: [] }, { taskId: 42, add: [5], remove: ["5"] }, { taskId: 42, add: [42] }, { taskId: 42, remove: [42] }]) {
      await expect(op("task_related_edit").execute(ctx, args)).rejects.toThrow(OpInputError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

const parent = (parentId: string | null) => ({ result: { task: { id: "42", parentId } } });
const parentGet = rest("/rest/tasks.task.get.json", { taskId: 42, select: ["ID", "PARENT_ID"] });
const childAdd = (parentId: number) =>
  json("tasks.v2.Task.Relation.Child.add", { taskId: parentId, tasks: [{ id: 42 }], noOverride: false, relationKind: "parent" });
const childDelete = (parentId: number) => json("tasks.v2.Task.Relation.Child.delete", { taskId: parentId, tasks: [{ id: 42 }] });

describe("task_parent", () => {
  it("detaches the task from its current parent, attaches it to the new one and re-reads", async () => {
    const { ctx, call } = fakeCtx(replies(parent("7"), { status: "success", data: { 42: true } }, done(42), parent("9")));

    const result = await op("task_parent").execute(ctx, { taskId: 42, parentId: "9" });

    expect(call).toHaveBeenCalledTimes(4);
    expect(call.mock.calls[0][0]).toEqual(parentGet);
    expect(call.mock.calls[1][0]).toEqual(childDelete(7));
    expect(call.mock.calls[2][0]).toEqual(childAdd(9));
    expect(call.mock.calls[3][0]).toEqual(parentGet);
    expect(result).toEqual({ taskId: 42, parentId: 9, previousParentId: 7, changed: true });
  });

  it("attaches a task without a parent without detaching anything", async () => {
    const { ctx, call } = fakeCtx(replies(parent(null), done(42), parent("9")));

    const result = await op("task_parent").execute(ctx, { taskId: 42, parentId: 9 });

    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[1][0]).toEqual(childAdd(9));
    expect(result).toEqual({ taskId: 42, parentId: 9, previousParentId: null, changed: true });
  });

  it("clears the parent with null", async () => {
    const { ctx, call } = fakeCtx(replies(parent("7"), done(42), parent(null)));

    const result = await op("task_parent").execute(ctx, { taskId: 42, parentId: null });

    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[1][0]).toEqual(childDelete(7));
    expect(result).toEqual({ taskId: 42, parentId: null, previousParentId: 7, changed: true });
  });

  it("reads parent \"0\" as no parent", async () => {
    const { ctx, call } = fakeCtx(replies(parent("0")));

    const result = await op("task_parent").execute(ctx, { taskId: 42, parentId: null });

    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ taskId: 42, parentId: null, previousParentId: null, changed: false });
  });

  it("writes nothing when the parent is already the asked one", async () => {
    const { ctx, call } = fakeCtx(replies(parent("9")));

    const result = await op("task_parent").execute(ctx, { taskId: 42, parentId: 9 });

    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ taskId: 42, parentId: 9, previousParentId: 9, changed: false });
  });

  it("does not write when the parent cannot be read or comes back in an unexpected shape", async () => {
    for (const reply of [new Error("timeout"), { result: { task: { id: "42" } } }]) {
      const { ctx, call } = fakeCtx(replies(reply));

      await expect(op("task_parent").execute(ctx, { taskId: 42, parentId: 9 })).rejects.toThrow();
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("names the old parent to restore when the attach fails after the detach", async () => {
    const { ctx } = fakeCtx(replies(parent("7"), done(42), new Error("TASKS_ERROR")));

    await expect(op("task_parent").execute(ctx, { taskId: 42, parentId: 9 })).rejects.toThrow(
      /отвязана от родителя 7.*TASKS_ERROR.*parentId: 7/,
    );
  });

  it("fails when the re-read parent is not the asked one", async () => {
    const { ctx } = fakeCtx(replies(parent(null), done(42), parent(null)));

    await expect(op("task_parent").execute(ctx, { taskId: 42, parentId: 9 })).rejects.toThrow(/Bitrix не применил.*нет\)$/);
  });

  it("names the old parent to restore when the re-read shows neither the old nor the new one", async () => {
    const { ctx } = fakeCtx(replies(parent("7"), done(42), done(42), parent(null)));

    await expect(op("task_parent").execute(ctx, { taskId: 42, parentId: 9 })).rejects.toThrow(
      /сейчас родитель: нет\).*прежний родитель 7.*bitrix_task_parent \{ taskId: 42, parentId: 7 \}/,
    );
  });

  it("offers no restore when the task still has its old parent", async () => {
    const { ctx } = fakeCtx(replies(parent("7"), done(42), parent("7")));

    await expect(op("task_parent").execute(ctx, { taskId: 42, parentId: null })).rejects.toThrow(/сейчас родитель: 7\)$/);
  });

  it("says the write was sent and names the old parent when the re-read fails", async () => {
    const { ctx } = fakeCtx(replies(parent("7"), done(42), new Error("timeout")));

    await expect(op("task_parent").execute(ctx, { taskId: 42, parentId: null })).rejects.toThrow(
      /отправлен.*timeout.*bitrix_task_parent \{ taskId: 42, parentId: 7 \}/,
    );
  });

  it("names the old parent to restore when the detach request fails", async () => {
    const { ctx, call } = fakeCtx(replies(parent("7"), new Error("timeout")));

    await expect(op("task_parent").execute(ctx, { taskId: 42, parentId: 9 })).rejects.toThrow(
      /отвязать от родителя 7 не удалось: timeout.*parentId: 7/,
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("rejects the task as its own parent or a missing parentId before any request", async () => {
    const { ctx, call } = fakeCtx();

    for (const args of [{ taskId: 42, parentId: 42 }, { taskId: 42 }]) {
      await expect(op("task_parent").execute(ctx, args)).rejects.toThrow(OpInputError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

// The dependent task's flag covers all of its Gantt links: the only read there is.
const ganttFlag = (containsGanttLinks: unknown) => ({ status: "success", data: { id: 43, containsGanttLinks, parent: { containsGanttLinks: null } } });
const flagRead = json("tasks.v2.Task.get", { task: { id: 43 } });
const pair = { taskIdFrom: 42, taskIdTo: 43 };
const DONE = { result: [] };

describe("task_gantt_link", () => {
  it("adds the link finish → start through classic REST and sees the flag turn on", async () => {
    const { ctx, call } = fakeCtx(replies(ganttFlag(false), DONE, ganttFlag(true)));

    const result = await op("task_gantt_link").execute(ctx, { taskId: "42", dependentId: "43" });

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      flagRead,
      rest("/rest/task.dependence.add.json", { ...pair, linkType: 2 }),
      flagRead,
    ]);
    expect(result).toEqual({ taskId: 42, dependentId: 43, linked: true, confirmed: true });
  });

  it("fails when the flag stays off after the add", async () => {
    const { ctx } = fakeCtx(replies(ganttFlag(false), DONE, ganttFlag(false)));

    await expect(op("task_gantt_link").execute(ctx, { taskId: 42, dependentId: 43 })).rejects.toThrow(/не применил/);
  });

  it("says the add cannot be confirmed when the dependent task already had Gantt links", async () => {
    const { ctx, call } = fakeCtx(replies(ganttFlag(true), DONE, ganttFlag(true)));

    const result = await op("task_gantt_link").execute(ctx, { taskId: 42, dependentId: 43 });

    expect(call).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ taskId: 42, dependentId: 43, linked: true, confirmed: false });
    expect(result).toHaveProperty("note", expect.stringMatching(/уже были связи Ганта/));
  });

  it("writes nothing when the flag cannot be read first", async () => {
    for (const reply of [ganttFlag(null), { status: "success", data: { id: 43 } }, new Error("доступ запрещён")]) {
      const { ctx, call } = fakeCtx(replies(reply));

      await expect(op("task_gantt_link").execute(ctx, { taskId: 42, dependentId: 43 })).rejects.toThrow();
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("tells a sent add from a failed one when the re-read fails", async () => {
    const { ctx } = fakeCtx(replies(ganttFlag(false), DONE, new Error("сеть")));

    await expect(op("task_gantt_link").execute(ctx, { taskId: 42, dependentId: 43 })).rejects.toThrow(/запись отправлена.*bitrix_task_get_v2/);
  });

  it("removes the link and sees the flag turn off", async () => {
    const { ctx, call } = fakeCtx(replies(DONE, ganttFlag(false)));

    const result = await op("task_gantt_link").execute(ctx, { taskId: 42, dependentId: 43, remove: true });

    expect(call.mock.calls.map((c) => c[0])).toEqual([rest("/rest/task.dependence.delete.json", pair), flagRead]);
    expect(result).toEqual({ taskId: 42, dependentId: 43, linked: false, confirmed: true });
  });

  it("says the removal cannot be confirmed while the dependent task keeps Gantt links", async () => {
    const { ctx } = fakeCtx(replies(DONE, ganttFlag(true)));

    const result = await op("task_gantt_link").execute(ctx, { taskId: 42, dependentId: 43, remove: true });

    expect(result).toMatchObject({ taskId: 42, dependentId: 43, linked: false, confirmed: false });
    expect(result).toHaveProperty("note", expect.stringMatching(/остаются связи Ганта/));
  });

  it("rejects a self-link, an unknown type or a type on removal before any request", async () => {
    const { ctx, call } = fakeCtx();

    for (const args of [
      { taskId: 42, dependentId: 42 },
      { taskId: 42, dependentId: 43, type: "start_start" },
      { taskId: 42, dependentId: 43, remove: true, type: "finish_start" },
    ]) {
      await expect(op("task_gantt_link").execute(ctx, args)).rejects.toThrow(OpInputError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});
