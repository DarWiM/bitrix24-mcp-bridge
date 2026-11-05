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
    return pages[i++];
  };
}

function op(name: string): Operation {
  const found = OPERATIONS.find((o) => o.name === name);
  if (!found) throw new Error(`no operation ${name}`);
  return found;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("expected promise to reject");
}

const rest = (endpoint: string, params: Record<string, unknown>): CallTarget =>
  ({ endpoint, action: null, method: "POST", bodyType: "form", responseType: "json", params });
const json = (action: string, params: Record<string, unknown>): CallTarget =>
  ({ endpoint: AJAX, action, method: "POST", bodyType: "json", responseType: "json", params });

const taskReply = (stageId: string, status = "2", groupId = "15") => ({ result: { task: { id: "42", groupId, stageId, status } } });
const activeSprint = { result: [{ id: 7, groupId: 15, status: "active", name: "Спринт 3" }] };
const sprintStages = {
  result: [
    { id: "60", name: "Готово", sort: "300", type: "FINISH", sprintId: "7" },
    { id: "58", name: "Новые", sort: "100", type: "NEW", sprintId: "7" },
    { id: "61", name: "Testing", sort: "250", type: "", sprintId: "7" },
    { id: "59", name: "В работе", sort: "200", type: "WORK", sprintId: "7" },
  ],
};
const COLUMNS = [
  { id: 58, name: "Новые", type: "NEW" },
  { id: 59, name: "В работе", type: "WORK" },
  { id: 61, name: "Testing", type: "" },
  { id: 60, name: "Готово", type: "FINISH" },
];
const TASK_STAGE_SELECT = ["ID", "GROUP_ID", "STAGE_ID", "STATUS"];

describe("write operations in OPERATIONS", () => {
  it("registers sprint_columns and user_find as reads and the others as mutating", () => {
    expect(op("sprint_columns").mutating).toBe(false);
    expect(op("user_find").mutating).toBe(false);
    for (const name of [
      "task_description_set", "task_description_append", "chat_send", "task_move", "task_result_add",
      "task_delegate", "task_accomplices", "task_auditors",
    ]) {
      expect(op(name).mutating).toBe(true);
    }
  });

  it("takes no agent params", () => {
    for (const name of [
      "task_description_set", "task_description_append", "chat_send", "sprint_columns", "task_move", "task_result_add",
      "task_delegate", "task_accomplices", "task_auditors", "user_find",
    ]) {
      expect(Object.keys(op(name).input)).not.toContain("params");
    }
  });

  it("refuses every mutating one before any request when mutations are off", async () => {
    const { ctx, call } = fakeCtx();
    const reg = createRegistry(OPERATIONS);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["task_description_set", { taskId: 1, text: "x" }],
      ["task_description_append", { taskId: 1, text: "x" }],
      ["chat_send", { chatId: 1, text: "x" }],
      ["task_move", { taskIds: [1], column: "Готово" }],
      ["task_result_add", { taskIds: [1], text: "x" }],
      ["task_delegate", { taskIds: [1], userId: 2 }],
      ["task_accomplices", { taskIds: [1], add: [2] }],
      ["task_auditors", { taskIds: [1], remove: [2] }],
    ];
    for (const [name, args] of calls) {
      const err = await rejection(runOperation(reg, name, args, ctx, { allowMutations: false }));
      expect(err).toBeInstanceOf(OpRefusedError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_description_set", () => {
  it("sends classic tasks.task.update with the DESCRIPTION field", async () => {
    const { ctx, call } = fakeCtx();

    const result = await op("task_description_set").execute(ctx, { taskId: "42", text: "[b]Итог[/b]" });

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toEqual(rest("/rest/tasks.task.update.json", { taskId: 42, fields: { DESCRIPTION: "[b]Итог[/b]" } }));
    expect(result).toEqual({ taskId: 42, length: 11 });
  });

  it("accepts an empty text to clear the description", async () => {
    const { ctx, call } = fakeCtx();

    await op("task_description_set").execute(ctx, { taskId: 42, text: "" });

    expect(call.mock.calls[0][0].params).toEqual({ taskId: 42, fields: { DESCRIPTION: "" } });
  });

  it("rejects a text over 100 000 characters before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("task_description_set").execute(ctx, { taskId: 42, text: "a".repeat(100_001) })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_description_append", () => {
  it("reads the raw description and writes it back with the new text after a blank line", async () => {
    const current = "Описание\n[disk file id=22081]\n[list][*]пункт[/list]\n\n";
    const { ctx, call } = fakeCtx(replies({ status: "success", data: { id: 42, description: current } }, { result: { task: {} } }));

    const result = await op("task_description_append").execute(ctx, { taskId: 42, text: "Дописано" });

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0]).toEqual(json("tasks.v2.Task.get", { task: { id: 42 } }));
    const expected = "Описание\n[disk file id=22081]\n[list][*]пункт[/list]\n\nДописано";
    expect(call.mock.calls[1][0]).toEqual(rest("/rest/tasks.task.update.json", { taskId: 42, fields: { DESCRIPTION: expected } }));
    expect(result).toEqual({ taskId: 42, length: expected.length });
  });

  for (const description of ["", null, "  \n"]) {
    it(`writes just the new text when the current description is ${JSON.stringify(description)}`, async () => {
      const { ctx, call } = fakeCtx(replies({ status: "success", data: { id: 42, description } }, { result: true }));

      await op("task_description_append").execute(ctx, { taskId: 42, text: "Первый абзац" });

      expect(call.mock.calls[1][0].params).toEqual({ taskId: 42, fields: { DESCRIPTION: "Первый абзац" } });
    });
  }

  it("does not write when the read comes back in an unexpected shape", async () => {
    const { ctx, call } = fakeCtx(replies({ status: "success", data: [] }));

    await expect(op("task_description_append").execute(ctx, { taskId: 42, text: "x" })).rejects.toThrow(/unexpected shape/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty text before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("task_description_append").execute(ctx, { taskId: 42, text: "" })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("chat_send", () => {
  it("addresses a chat by chatId as DIALOG_ID chat<id>", async () => {
    const { ctx, call } = fakeCtx(async () => ({ result: 1884131 }));

    const result = await op("chat_send").execute(ctx, { chatId: "40271", text: "Привет, [user=11]Пётр[/user]" });

    expect(call.mock.calls[0][0]).toEqual(rest("/rest/im.message.add.json", { DIALOG_ID: "chat40271", MESSAGE: "Привет, [user=11]Пётр[/user]" }));
    expect(result).toEqual({ chatId: 40271, dialogId: "chat40271", messageId: 1884131 });
  });

  it("passes a dialogId through as is", async () => {
    const { ctx, call } = fakeCtx(async () => ({ result: "77" }));

    const result = await op("chat_send").execute(ctx, { dialogId: "11", text: "ok" });

    expect(call.mock.calls[0][0]).toEqual(rest("/rest/im.message.add.json", { DIALOG_ID: "11", MESSAGE: "ok" }));
    expect(result).toEqual({ dialogId: "11", messageId: 77 });
  });

  for (const [title, args] of [
    ["both chatId and dialogId", { chatId: 1, dialogId: "chat1", text: "x" }],
    ["neither chatId nor dialogId", { text: "x" }],
    ["a text over 20 000 characters", { chatId: 1, text: "a".repeat(20_001) }],
    ["an empty text", { chatId: 1, text: "" }],
  ] as const) {
    it(`rejects ${title} before any request`, async () => {
      const { ctx, call } = fakeCtx();

      const err = await rejection(op("chat_send").execute(ctx, args));

      expect(err).toBeInstanceOf(OpInputError);
      expect(call).not.toHaveBeenCalled();
    });
  }

  it("names both addressing fields when the choice is wrong", async () => {
    const { ctx } = fakeCtx();

    const err = await rejection(op("chat_send").execute(ctx, { text: "x" }));

    expect(err.message).toContain("exactly one of chatId / dialogId");
  });
});

describe("sprint_columns", () => {
  it("finds the active sprint and returns its columns in board order", async () => {
    const { ctx, call } = fakeCtx(replies(activeSprint, sprintStages));

    const result = await op("sprint_columns").execute(ctx, { groupId: 15 });

    expect(call.mock.calls[0][0]).toEqual(rest("/rest/tasks.api.scrum.sprint.list.json", { filter: { GROUP_ID: 15, STATUS: "active" } }));
    expect(call.mock.calls[1][0]).toEqual(rest("/rest/tasks.api.scrum.kanban.getStages.json", { sprintId: 7 }));
    expect(result).toEqual({ groupId: 15, sprintId: 7, columns: COLUMNS });
  });

  it("explains when the project has no active sprint", async () => {
    const { ctx, call } = fakeCtx(replies({ result: [{ id: 6, status: "completed" }] }));

    await expect(op("sprint_columns").execute(ctx, { groupId: 15 })).rejects.toThrow("в проекте 15 нет активного спринта");
    expect(call).toHaveBeenCalledTimes(1);
  });
});


describe("task_move", () => {
  const getTask = (taskId: number) => rest("/rest/tasks.task.get.json", { taskId, select: TASK_STAGE_SELECT });
  const sprintList = rest("/rest/tasks.api.scrum.sprint.list.json", { filter: { GROUP_ID: 15, STATUS: "active" } });
  const stagesList = rest("/rest/tasks.api.scrum.kanban.getStages.json", { sprintId: 7 });
  const move = (id: number, stageId: number) => rest("/rest/task.stages.movetask.json", { id, stageId });

  it("resolves the column by name ignoring case, moves the task and returns the re-read stage and status", async () => {
    const { ctx, call } = fakeCtx(replies(taskReply("59"), activeSprint, sprintStages, { result: true }, taskReply("60", "5")));

    const result = await op("task_move").execute(ctx, { taskIds: [42], column: "  готово " });

    expect(call.mock.calls.map((c) => c[0])).toEqual([getTask(42), sprintList, stagesList, move(42, 60), getTask(42)]);
    expect(result).toEqual({ results: [{ taskId: 42, ok: true, stageId: 60, column: "Готово", status: 5 }] });
  });

  it("resolves the column by id", async () => {
    const { ctx, call } = fakeCtx(replies(taskReply("58"), activeSprint, sprintStages, { result: true }, taskReply("61")));

    const result = await op("task_move").execute(ctx, { taskIds: ["42"], column: 61 });

    expect(call.mock.calls[3][0].params).toEqual({ id: 42, stageId: 61 });
    expect(result).toEqual({ results: [{ taskId: 42, ok: true, stageId: 61, column: "Testing", status: 2 }] });
  });

  it("takes a digit string as a column id when no column has that name", async () => {
    const { ctx, call } = fakeCtx(replies(taskReply("58"), activeSprint, sprintStages, { result: true }, taskReply("59")));

    const result = await op("task_move").execute(ctx, { taskIds: [42], column: "59" });

    expect(call.mock.calls[3][0].params).toEqual({ id: 42, stageId: 59 });
    expect(result).toEqual({ results: [{ taskId: 42, ok: true, stageId: 59, column: "В работе", status: 2 }] });
  });

  it("moves a batch in order, looks the sprint columns up once per project and keeps going past a failed task", async () => {
    const { ctx, call } = fakeCtx(
      replies(
        taskReply("58"), activeSprint, sprintStages, { result: true }, taskReply("61"),
        taskReply("58"), { result: true }, taskReply("58"),
        taskReply("59"), { result: true }, taskReply("61", "5"),
      ),
    );

    const result = await op("task_move").execute(ctx, { taskIds: [42, 43, 44], column: "Testing" });

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      getTask(42), sprintList, stagesList, move(42, 61), getTask(42),
      getTask(43), move(43, 61), getTask(43),
      getTask(44), move(44, 61), getTask(44),
    ]);
    expect(result).toEqual({
      results: [
        { taskId: 42, ok: true, stageId: 61, column: "Testing", status: 2 },
        { taskId: 43, ok: false, error: "Bitrix ответил true, но задача не переехала — вероятно, её нет на доске спринта" },
        { taskId: 44, ok: true, stageId: 61, column: "Testing", status: 5 },
      ],
    });
  });

  it("lists the available columns for an unknown name, without moving", async () => {
    const { ctx, call } = fakeCtx(replies(taskReply("58"), activeSprint, sprintStages));

    const result = await op("task_move").execute(ctx, { taskIds: [42], column: "Ревью" });

    expect(result).toEqual({
      results: [
        {
          taskId: 42,
          ok: false,
          error: 'колонки "Ревью" нет на доске активного спринта; есть: «Новые» (58), «В работе» (59), «Testing» (61), «Готово» (60)',
        },
      ],
    });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("refuses a task outside any project before resolving columns", async () => {
    const { ctx, call } = fakeCtx(replies(taskReply("0", "2", "0")));

    const result = await op("task_move").execute(ctx, { taskIds: [42], column: "Готово" });

    expect(result).toEqual({ results: [{ taskId: 42, ok: false, error: expect.stringContaining("не в проекте") }] });
    expect(call).toHaveBeenCalledTimes(1);
  });

  for (const [title, reread, cause] of [
    ["comes back in an unexpected shape", async () => ({ result: [] }), "tasks.task.get returned an unexpected shape"],
    ["fails", async () => {
      throw new Error("extension not connected");
    }, "extension not connected"],
  ] as const) {
    it(`says the move was sent when the re-read ${title}`, async () => {
      const first = replies(taskReply("58"), activeSprint, sprintStages, { result: true });
      let n = 0;
      const { ctx } = fakeCtx(async (target) => (n++ < 4 ? first(target) : reread()));

      const result = await op("task_move").execute(ctx, { taskIds: [42], column: "Готово" });

      expect(result).toEqual({
        results: [
          {
            taskId: 42,
            ok: false,
            error: `перенос отправлен, но перечитать задачу не удалось (проверь её колонку через bitrix_task_get): ${cause}`,
          },
        ],
      });
    });
  }

  it("rejects an empty taskIds list before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("task_move").execute(ctx, { taskIds: [], column: "Готово" })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_result_add", () => {
  it("sends tasks.v2.Task.Result.add as json per task and returns each new result id", async () => {
    const { ctx, call } = fakeCtx(
      replies(
        { status: "success", data: [{ id: 913, taskId: 42, text: "Готово" }], errors: [] },
        { status: "success", data: [], errors: [] },
        { status: "success", data: [{ id: 915, taskId: 44, text: "Готово" }], errors: [] },
      ),
    );

    const result = await op("task_result_add").execute(ctx, { taskIds: [42, 43, 44], text: "Готово" });

    expect(call.mock.calls.map((c) => c[0])).toEqual([42, 43, 44].map((taskId) => json("tasks.v2.Task.Result.add", { results: [{ taskId, text: "Готово" }] })));
    expect(result).toEqual({
      results: [
        { taskId: 42, ok: true, resultId: 913 },
        { taskId: 43, ok: false, error: "tasks.v2.Task.Result.add returned an unexpected shape" },
        { taskId: 44, ok: true, resultId: 915 },
      ],
    });
  });

  it("rejects a duplicated task id before any request", async () => {
    const { ctx, call } = fakeCtx();

    const err = await rejection(op("task_result_add").execute(ctx, { taskIds: [42, 42], text: "Готово" }));

    expect(err).toBeInstanceOf(OpInputError);
    expect(err.message).toContain("taskIds: task 42 is listed more than once");
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a text over 20 000 characters before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("task_result_add").execute(ctx, { taskIds: [42], text: "a".repeat(20_001) })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_delegate", () => {
  const delegate = (taskId: number, userId: number) => rest("/rest/tasks.task.delegate.json", { taskId, userId });
  const getResponsible = (taskId: number) => rest("/rest/tasks.task.get.json", { taskId, select: ["ID", "RESPONSIBLE_ID"] });
  const responsible = (id: string) => ({ result: { task: { id: "42", responsibleId: id } } });

  it("delegates each task in order, re-reads the responsible and keeps going past a failed task", async () => {
    const { ctx, call } = fakeCtx(replies({ result: { task: {} } }, responsible("11"), { result: { task: {} } }, responsible("9")));

    const result = await op("task_delegate").execute(ctx, { taskIds: [42, 43], userId: "11" });

    expect(call.mock.calls.map((c) => c[0])).toEqual([delegate(42, 11), getResponsible(42), delegate(43, 11), getResponsible(43)]);
    expect(result).toEqual({
      results: [
        { taskId: 42, ok: true, responsibleId: 11 },
        { taskId: 43, ok: false, error: "Bitrix ответил успехом, но ответственный не сменился (сейчас 9)" },
      ],
    });
  });

  for (const [title, reread, cause] of [
    ["comes back in an unexpected shape", async () => ({ result: { task: {} } }), "tasks.task.get returned an unexpected shape"],
    ["fails", async () => {
      throw new Error("extension not connected");
    }, "extension not connected"],
  ] as const) {
    it(`says the delegation was sent when the re-read ${title}`, async () => {
      let n = 0;
      const { ctx } = fakeCtx(async () => (n++ === 0 ? { result: { task: {} } } : reread()));

      const result = await op("task_delegate").execute(ctx, { taskIds: [42], userId: 11 });

      expect(result).toEqual({
        results: [
          {
            taskId: 42,
            ok: false,
            error: `делегирование отправлено, но перечитать задачу не удалось (проверь ответственного через bitrix_task_get): ${cause}`,
          },
        ],
      });
    });
  }

  it("does not re-read when the delegation itself fails", async () => {
    const { ctx, call } = fakeCtx(async () => {
      throw new Error("ACCESS_DENIED");
    });

    const result = await op("task_delegate").execute(ctx, { taskIds: [42], userId: 11 });

    expect(result).toEqual({ results: [{ taskId: 42, ok: false, error: "ACCESS_DENIED" }] });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing userId before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("task_delegate").execute(ctx, { taskIds: [42] })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});

for (const { name, field, key } of [
  { name: "task_accomplices", field: "ACCOMPLICES", key: "accomplices" },
  { name: "task_auditors", field: "AUDITORS", key: "auditors" },
] as const) {
  describe(name, () => {
    const read = (taskId: number) => rest("/rest/tasks.task.get.json", { taskId, select: ["ID", field] });
    const write = (taskId: number, value: number[] | "") => rest("/rest/tasks.task.update.json", { taskId, fields: { [field]: value } });
    const members = (...ids: string[]) => ({ result: { task: { id: "42", [key]: ids } } });

    const updated = { result: { task: {} } };

    it("adds and removes people on top of the current list and returns the re-read one", async () => {
      const { ctx, call } = fakeCtx(replies(members("5", "7", "9"), updated, members("5", "9", "11")));

      const result = await op(name).execute(ctx, { taskIds: [42], add: [11, "5"], remove: ["7"] });

      expect(call.mock.calls.map((c) => c[0])).toEqual([read(42), write(42, [5, 9, 11]), read(42)]);
      expect(result).toEqual({ results: [{ taskId: 42, ok: true, [key]: [5, 9, 11], changed: true }] });
    });

    it("computes each task's write from its own list", async () => {
      const { ctx, call } = fakeCtx(replies(members("5"), updated, members("5", "11"), members("3", "8"), updated, members("3", "11")));

      const result = await op(name).execute(ctx, { taskIds: [42, 43], add: [11], remove: [8] });

      expect(call.mock.calls.map((c) => c[0])).toEqual([read(42), write(42, [5, 11]), read(42), read(43), write(43, [3, 11]), read(43)]);
      expect(result).toEqual({
        results: [
          { taskId: 42, ok: true, [key]: [5, 11], changed: true },
          { taskId: 43, ok: true, [key]: [3, 11], changed: true },
        ],
      });
    });

    it("adds to an empty list without duplicating a repeated id", async () => {
      const { ctx, call } = fakeCtx(replies(members(), updated, members("11")));

      const result = await op(name).execute(ctx, { taskIds: [42], add: [11, 11] });

      expect(call.mock.calls[1][0]).toEqual(write(42, [11]));
      expect(result).toEqual({ results: [{ taskId: 42, ok: true, [key]: [11], changed: true }] });
    });

    it('clears the list with "" because an empty array vanishes from the form body', async () => {
      const { ctx, call } = fakeCtx(replies(members("5"), updated, members()));

      const result = await op(name).execute(ctx, { taskIds: [42], remove: [5] });

      expect(call.mock.calls[1][0]).toEqual(write(42, ""));
      expect(result).toEqual({ results: [{ taskId: 42, ok: true, [key]: [], changed: true }] });
    });

    it("does not write when nothing changes", async () => {
      const { ctx, call } = fakeCtx(replies(members("5", "7")));

      const result = await op(name).execute(ctx, { taskIds: [42], add: [7], remove: [3] });

      expect(call.mock.calls.map((c) => c[0])).toEqual([read(42)]);
      expect(result).toEqual({ results: [{ taskId: 42, ok: true, [key]: [5, 7], changed: false }] });
    });

    it("does not write when the read comes back in an unexpected shape", async () => {
      const { ctx, call } = fakeCtx(replies({ result: { task: { id: "42" } } }, members("3"), updated, members("3", "11")));

      const result = await op(name).execute(ctx, { taskIds: [42, 43], add: [11] });

      expect(call.mock.calls.map((c) => c[0])).toEqual([read(42), read(43), write(43, [3, 11]), read(43)]);
      expect(result).toEqual({
        results: [
          { taskId: 42, ok: false, error: "tasks.task.get returned an unexpected shape" },
          { taskId: 43, ok: true, [key]: [3, 11], changed: true },
        ],
      });
    });

    it("does not write when the read fails", async () => {
      const { ctx, call } = fakeCtx(async () => {
        throw new Error("extension not connected");
      });

      const result = await op(name).execute(ctx, { taskIds: [42], add: [11] });

      expect(call.mock.calls.map((c) => c[0])).toEqual([read(42)]);
      expect(result).toEqual({ results: [{ taskId: 42, ok: false, error: "extension not connected" }] });
    });

    it("fails the task and names what Bitrix did not apply when the re-read list differs", async () => {
      const { ctx } = fakeCtx(replies(members("5", "7"), updated, members("5", "7")));

      const result = await op(name).execute(ctx, { taskIds: [42], add: [11], remove: [7] });

      expect(result).toEqual({
        results: [{ taskId: 42, ok: false, error: "Bitrix не применил: добавить 11; убрать 7 (сейчас в списке: 5, 7)" }],
      });
    });

    for (const [title, reread, cause] of [
      ["comes back in an unexpected shape", async () => ({ result: { task: {} } }), "tasks.task.get returned an unexpected shape"],
      ["fails", async () => {
        throw new Error("extension not connected");
      }, "extension not connected"],
    ] as const) {
      it(`says the write was sent when the re-read ${title}`, async () => {
        const first = replies(members("5"), updated);
        let n = 0;
        const { ctx } = fakeCtx(async (target) => (n++ < 2 ? first(target) : reread()));

        const result = await op(name).execute(ctx, { taskIds: [42], add: [11] });

        expect(result).toEqual({
          results: [
            {
              taskId: 42,
              ok: false,
              error: `запись отправлена, но перечитать задачу не удалось (проверь список через bitrix_task_get): ${cause}`,
            },
          ],
        });
      });
    }

    for (const [title, args] of [
      ["neither add nor remove", { taskIds: [42] }],
      ["only empty lists", { taskIds: [42], add: [], remove: [] }],
      ["the same person in add and remove", { taskIds: [42], add: [5], remove: ["5"] }],
    ] as const) {
      it(`rejects ${title} before any request`, async () => {
        const { ctx, call } = fakeCtx();

        const err = await rejection(op(name).execute(ctx, args));

        expect(err).toBeInstanceOf(OpInputError);
        expect(call).not.toHaveBeenCalled();
      });
    }
  });
}

describe("user_find", () => {
  it("searches user.get by last name and returns compact cards, inactive ones included", async () => {
    const { ctx, call } = fakeCtx(async () => ({
      result: [
        { ID: "11", NAME: "Пётр", LAST_NAME: "Иванов", ACTIVE: true, WORK_POSITION: "Разработчик", EMAIL: "p@example.com" },
        { ID: "7225", NAME: "Иван", LAST_NAME: "Иванов", ACTIVE: false, WORK_POSITION: null },
      ],
      total: 2,
    }));

    const result = await op("user_find").execute(ctx, { lastName: " Иванов " });

    expect(call.mock.calls[0][0]).toEqual(rest("/rest/user.get.json", { FILTER: { LAST_NAME: "Иванов" } }));
    expect(result).toEqual([
      { id: 11, name: "Пётр", lastName: "Иванов", active: true, workPosition: "Разработчик" },
      { id: 7225, name: "Иван", lastName: "Иванов", active: false, workPosition: "" },
    ]);
  });

  it("rejects an empty last name before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("user_find").execute(ctx, { lastName: "  " })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});
