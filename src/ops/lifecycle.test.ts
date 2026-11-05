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
const form = (action: string, params: Record<string, unknown>): CallTarget =>
  ({ endpoint: AJAX, action, method: "POST", bodyType: "form", responseType: "json", params });

const taskGet = (taskId: number) =>
  rest("/rest/tasks.task.get.json", { taskId, select: ["ID", "GROUP_ID", "STAGE_ID", "STATUS"] });
const task = (status: string, groupId: string | null = "17") => ({ result: { task: { id: "31981", status, groupId, stageId: "0" } } });
const complete = (id: number) => json("tasks.v2.Task.Status.complete", { task: { id }, completeWithChecklist: true });
const renew = (id: number) => json("tasks.v2.Task.Status.renew", { task: { id } });
const dod = (name: string, params: Record<string, unknown>) => form(`bitrix:tasks.scrum.doD.${name}`, params);
const ajaxOk = (data: unknown) => ({ status: "success", data, errors: [] });

// Recorded group 17: type 1 needs DoD and has three criteria under one group item, type 3 has none.
const SETTINGS = ajaxOk({
  types: [
    { id: 1, entityId: 1, name: "Продуктовая задача", sort: 1, dodRequired: "Y", participants: [] },
    { id: 3, entityId: 1, name: "Техническая задача", sort: 2, dodRequired: "N", participants: [] },
  ],
  activeTypeId: 0,
});
const leaf = (nodeId: number, copiedId: number, title: string, sortIndex: number) => ({
  NODE_ID: nodeId,
  FIELDS: { ID: null, COPIED_ID: copiedId, PARENT_ID: 97, TITLE: title, SORT_INDEX: sortIndex, IS_COMPLETE: false, IS_IMPORTANT: false, NODE_ID: `n${nodeId}` },
  ACTION: { MODIFY: false, REMOVE: false, TOGGLE: true, DRAG: false },
  DESCENDANTS: [],
});
const CRITERIA = [
  {
    NODE_ID: 1,
    FIELDS: { ID: null, COPIED_ID: 97, PARENT_ID: 0, TITLE: "Критерии готовности", SORT_INDEX: 0, IS_COMPLETE: false, IS_IMPORTANT: false, NODE_ID: "ydtf3yf3m" },
    ACTION: { MODIFY: false, REMOVE: false, TOGGLE: true, DRAG: false },
    DESCENDANTS: [
      leaf(2, 99, "Задача проверена (выполнено тестирование или результат согласован с постановщиком)", 0),
      leaf(3, 101, "Задача принята владельцем продукта", 1),
      leaf(4, 103, "Подготовлено описание или документация (при необходимости)", 2),
    ],
  },
];
// The page getList hands back: the items ride inside the script that renders the checklist.
const listPage = (descendants: unknown[]) => {
  const data = {
    userId: 55,
    entityId: 2373,
    entityType: "SCRUM_ITEM",
    items: { NODE_ID: 0, FIELDS: { ID: null, TITLE: "", PARENT_ID: null }, ACTION: [], DESCENDANTS: descendants },
    prefix: "",
  };
  const html =
    `<div class="tasks-scrum-dod-checklist" id="dod-list"></div><script>BX.ready(function() {` +
    ` var renderTo = document.getElementById("dod-list"); var data = Object.assign(renderTo, ${JSON.stringify(data)});` +
    ` BX.Tasks.CheckListInstance = new BX.Tasks.CheckList(data); });</script>`;
  return ajaxOk({ html });
};
const GROUP_PARAMS = { groupId: 17, taskId: 31981 };
const groupGet = (groupId: number) => form("socialnetwork.api.workgroup.get", { params: { groupId, select: ["ID", "TYPE"] } });
const group = (type: string) => ajaxOk({ ID: "17", NAME: "Проект", PROJECT: "Y", TYPE: type });
const SCRUM = group("scrum");

describe("lifecycle operations in OPERATIONS", () => {
  it("registers them as mutating, under the long budget, none taking agent params", () => {
    for (const name of ["task_close", "task_reopen"]) {
      expect(op(name).mutating).toBe(true);
      expect(op(name).budget).toBe("long");
      expect(Object.keys(op(name).input)).not.toContain("params");
    }
  });

  it("refuses both before any request when mutations are off", async () => {
    const { ctx, call } = fakeCtx();
    const reg = createRegistry(OPERATIONS);
    await expect(runOperation(reg, "task_close", { taskId: 1 }, ctx, { allowMutations: false })).rejects.toThrow(OpRefusedError);
    await expect(runOperation(reg, "task_reopen", { taskIds: [1] }, ctx, { allowMutations: false })).rejects.toThrow(OpRefusedError);
    expect(call).not.toHaveBeenCalled();
  });

  it("tells the agent to get the user's agreement before marking the criteria", () => {
    expect(op("task_close").description).toContain("согласие");
    expect(op("task_close").description).toContain("confirmItems");
  });
});

describe("task_close — step 1", () => {
  it("closes at once when the project does not need DoD for the task and checks the task closed", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), SCRUM, ajaxOk(false), ajaxOk({ id: 31981 }), task("5")));
    const out = await op("task_close").execute(ctx, { taskId: 31981 });
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      taskGet(31981),
      groupGet(17),
      dod("isNecessary", GROUP_PARAMS),
      complete(31981),
      taskGet(31981),
    ]);
    expect(out).toEqual({ taskId: 31981, status: 5, changed: true });
  });

  it("closes a task outside any project without asking about DoD", async () => {
    const { ctx, call } = fakeCtx(replies(task("3", "0"), ajaxOk({ id: 31981 }), task("5", "0")));
    const out = await op("task_close").execute(ctx, { taskId: 31981 });
    expect(call.mock.calls.map((c) => c[0])).toEqual([taskGet(31981), complete(31981), taskGet(31981)]);
    expect(out).toEqual({ taskId: 31981, status: 5, changed: true });
  });

  it("closes a task of a non-scrum project without asking about DoD", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), group("project"), ajaxOk({ id: 31981 }), task("5")));
    const out = await op("task_close").execute(ctx, { taskId: 31981 });
    expect(call.mock.calls.map((c) => c[0])).toEqual([taskGet(31981), groupGet(17), complete(31981), taskGet(31981)]);
    expect(out).toEqual({ taskId: 31981, status: 5, changed: true });
  });

  it("fails without closing when the project's type cannot be read", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), ajaxOk({ ID: "17", NAME: "Проект" })));
    await expect(op("task_close").execute(ctx, { taskId: 31981 })).rejects.toThrow(/workgroup\.get/);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("does not close when DoD is needed and returns every type with its criteria", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), SCRUM, ajaxOk(true), SETTINGS, listPage(CRITERIA), listPage([])));
    const out = await op("task_close").execute(ctx, { taskId: 31981 });
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      taskGet(31981),
      groupGet(17),
      dod("isNecessary", GROUP_PARAMS),
      dod("getSettings", { ...GROUP_PARAMS, saveRequest: "N" }),
      dod("getList", { ...GROUP_PARAMS, typeId: 1 }),
      dod("getList", { ...GROUP_PARAMS, typeId: 3 }),
    ]);
    expect(out).toEqual({
      taskId: 31981,
      needsConfirmation: true,
      types: [
        {
          id: 1,
          name: "Продуктовая задача",
          required: true,
          items: [
            { title: "Критерии готовности" },
            { title: "Задача проверена (выполнено тестирование или результат согласован с постановщиком)" },
            { title: "Задача принята владельцем продукта" },
            { title: "Подготовлено описание или документация (при необходимости)" },
          ],
        },
        { id: 3, name: "Техническая задача", required: false, items: [] },
      ],
    });
  });

  it("reads criteria whose titles carry braces and quotes", async () => {
    const tricky = [leaf(1, 5, 'Код в {скобках} и "кавычках" }', 0)];
    const { ctx } = fakeCtx(replies(task("2"), SCRUM, ajaxOk(true), SETTINGS, listPage(tricky), listPage([])));
    const out = await op("task_close").execute(ctx, { taskId: 31981 });
    expect(out).toMatchObject({ types: [{ id: 1, items: [{ title: 'Код в {скобках} и "кавычках" }' }] }, { id: 3, items: [] }] });
  });

  it("fails without closing when the criteria cannot be found in the page", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), SCRUM, ajaxOk(true), SETTINGS, ajaxOk({ html: "<div>нет данных</div>" })));
    await expect(op("task_close").execute(ctx, { taskId: 31981 })).rejects.toThrow(/DoD/);
    expect(call).toHaveBeenCalledTimes(5);
  });

  it("fails without closing when Bitrix does not say whether DoD is needed", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), SCRUM, ajaxOk(null)));
    await expect(op("task_close").execute(ctx, { taskId: 31981 })).rejects.toThrow(/isNecessary/);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("leaves an already closed task alone", async () => {
    const { ctx, call } = fakeCtx(replies(task("5")));
    const out = await op("task_close").execute(ctx, { taskId: 31981 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ taskId: 31981, status: 5, changed: false });
  });

  it("fails when Bitrix answers success but the task stays open", async () => {
    const { ctx } = fakeCtx(replies(task("2"), SCRUM, ajaxOk(false), ajaxOk({ id: 31981 }), task("2")));
    await expect(op("task_close").execute(ctx, { taskId: 31981 })).rejects.toThrow(/не закрылась.*статус 2/);
  });
});

describe("task_close — step 2", () => {
  it("marks every criterion of the chosen type done, then closes and checks the task closed", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), SCRUM, SETTINGS, listPage(CRITERIA), ajaxOk(""), ajaxOk({ id: 31981 }), task("5")));
    const out = await op("task_close").execute(ctx, { taskId: 31981, typeId: 1, confirmItems: true });
    const targets = call.mock.calls.map((c) => c[0]);
    expect(targets.map((t) => t.action ?? t.endpoint)).toEqual([
      "/rest/tasks.task.get.json",
      "socialnetwork.api.workgroup.get",
      "bitrix:tasks.scrum.doD.getSettings",
      "bitrix:tasks.scrum.doD.getList",
      "bitrix:tasks.scrum.doD.saveList",
      "tasks.v2.Task.Status.complete",
      "/rest/tasks.task.get.json",
    ]);
    expect(targets[3]).toEqual(dod("getList", { ...GROUP_PARAMS, typeId: 1 }));
    expect(targets[5]).toEqual(complete(31981));

    const save = targets[4];
    expect(save).toMatchObject({ endpoint: AJAX, action: "bitrix:tasks.scrum.doD.saveList", bodyType: "form" });
    expect(save.params).toMatchObject({ typeId: 1, taskId: 31981, groupId: 17 });
    const items = save.params.items;
    if (!Array.isArray(items)) throw new Error("items is not a list");
    const [group, ...criteria] = items;
    expect(group).toMatchObject({ PARENT_NODE_ID: 0, COPIED_ID: 97, PARENT_ID: 0, TITLE: "Критерии готовности", SORT_INDEX: 0, IS_COMPLETE: true, IS_IMPORTANT: false });
    expect(criteria.map((c) => [c.COPIED_ID, c.PARENT_ID, c.SORT_INDEX, c.IS_COMPLETE, c.PARENT_NODE_ID])).toEqual([
      [99, 97, 0, true, group.NODE_ID],
      [101, 97, 1, true, group.NODE_ID],
      [103, 97, 2, true, group.NODE_ID],
    ]);
    const nodeIds = items.map((i) => i.NODE_ID);
    for (const id of nodeIds) expect(id).toMatch(/^[0-9a-z]{9}$/);
    expect(new Set(nodeIds).size).toBe(4);

    expect(out).toEqual({ taskId: 31981, status: 5, changed: true, typeId: 1 });
  });

  it("saves an empty list for a type without criteria and closes", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), SCRUM, SETTINGS, listPage([]), ajaxOk(""), ajaxOk({ id: 31981 }), task("5")));
    await op("task_close").execute(ctx, { taskId: 31981, typeId: "3", confirmItems: true });
    expect(call.mock.calls[4][0]).toEqual(dod("saveList", { typeId: 3, taskId: 31981, groupId: 17, items: [] }));
  });

  it("refuses a type the project does not have, before marking anything", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), SCRUM, SETTINGS));
    await expect(op("task_close").execute(ctx, { taskId: 31981, typeId: 7, confirmItems: true })).rejects.toThrow(/7.*1.*3/s);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("refuses a task outside any project: there is no DoD to confirm", async () => {
    const { ctx, call } = fakeCtx(replies(task("2", null)));
    await expect(op("task_close").execute(ctx, { taskId: 31981, typeId: 1, confirmItems: true })).rejects.toThrow(/без typeId/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("refuses a task of a non-scrum project: there is no DoD to confirm", async () => {
    const { ctx, call } = fakeCtx(replies(task("2"), group("project")));
    await expect(op("task_close").execute(ctx, { taskId: 31981, typeId: 1, confirmItems: true })).rejects.toThrow(/не в scrum-проекте/);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("says the criteria are already marked when closing then fails", async () => {
    const { ctx } = fakeCtx(replies(task("2"), SCRUM, SETTINGS, listPage(CRITERIA), ajaxOk(""), new Error("ACCESS_DENIED")));
    await expect(op("task_close").execute(ctx, { taskId: 31981, typeId: 1, confirmItems: true })).rejects.toThrow(/отмечены.*ACCESS_DENIED/);
  });

  it("leaves an already closed task alone without marking criteria", async () => {
    const { ctx, call } = fakeCtx(replies(task("5")));
    const out = await op("task_close").execute(ctx, { taskId: 31981, typeId: 1, confirmItems: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ taskId: 31981, status: 5, changed: false });
  });

  it("takes typeId and confirmItems: true only together", async () => {
    const { ctx, call } = fakeCtx();
    await expect(op("task_close").execute(ctx, { taskId: 1, typeId: 1 })).rejects.toThrow(OpInputError);
    await expect(op("task_close").execute(ctx, { taskId: 1, confirmItems: true })).rejects.toThrow(OpInputError);
    await expect(op("task_close").execute(ctx, { taskId: 1, typeId: 1, confirmItems: false })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_reopen", () => {
  it("renews closed tasks, leaves open ones alone and fails a renew that did nothing", async () => {
    const { ctx, call } = fakeCtx(
      replies(task("5"), ajaxOk({ id: 1 }), task("2"), task("3"), task("5"), ajaxOk({ id: 3 }), task("5")),
    );
    const out = await op("task_reopen").execute(ctx, { taskIds: [1, 2, 3] });
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      taskGet(1), renew(1), taskGet(1),
      taskGet(2),
      taskGet(3), renew(3), taskGet(3),
    ]);
    expect(out).toEqual({
      results: [
        { taskId: 1, ok: true, status: 2, changed: true },
        { taskId: 2, ok: true, status: 3, changed: false },
        { taskId: 3, ok: false, error: expect.stringContaining("осталась завершённой") },
      ],
    });
  });
});
