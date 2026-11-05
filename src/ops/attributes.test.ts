import { describe, it, expect, mock } from "bun:test";
import type { CallTarget, DownloadResult } from "../../shared/wire.js";
import { OpInputError, OpRefusedError, type OpContext, type Operation } from "./operation.js";
import { createRegistry, runOperation } from "./registry.js";
import { OPERATIONS } from "./index.js";

const AJAX = "/bitrix/services/main/ajax.php";

type CallFn = (target: CallTarget, portal?: string) => Promise<unknown>;

function fakeCtx(callFn: CallFn = async () => ({ data: true })) {
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

const ts = (iso: string) => Date.parse(iso) / 1000;
const card = (fields: Record<string, unknown>) => ({ status: "success", data: { id: 42, ...fields } });
const ok = { status: "success", data: true };

const MUTATING = ["task_priority", "task_deadline", "task_mute", "task_reminder_set", "task_reminder_delete"];

describe("attribute operations in OPERATIONS", () => {
  it("registers task_reminders as a read and the others as mutating, none taking agent params", () => {
    expect(op("task_reminders").mutating).toBe(false);
    for (const name of MUTATING) expect(op(name).mutating).toBe(true);
    for (const name of [...MUTATING, "task_reminders"]) expect(Object.keys(op(name).input)).not.toContain("params");
  });

  it("refuses every mutating one before any request when mutations are off", async () => {
    const { ctx, call } = fakeCtx();
    const reg = createRegistry(OPERATIONS);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["task_priority", { taskIds: [1], priority: "high" }],
      ["task_deadline", { taskIds: [1], deadline: null }],
      ["task_mute", { taskId: 1, muted: true }],
      ["task_reminder_set", { taskId: 1, at: "2026-11-10T09:00:00Z", via: "email" }],
      ["task_reminder_delete", { taskId: 1, reminderId: 1 }],
    ];
    for (const [name, args] of calls) {
      await expect(runOperation(reg, name, args, ctx, { allowMutations: false })).rejects.toThrow(OpRefusedError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_priority", () => {
  it("writes the priority of each task through the v2 update and re-reads it from the card", async () => {
    const { ctx, call } = fakeCtx(replies(card({ priority: "high" }), card({ priority: "high" }), card({ priority: "high" }), card({ priority: "high" })));

    const result = await op("task_priority").execute(ctx, { taskIds: [42, "43"], priority: "high" });

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      json("tasks.v2.Task.update", { task: { id: 42, priority: "high" } }),
      json("tasks.v2.Task.get", { task: { id: 42 } }),
      json("tasks.v2.Task.update", { task: { id: 43, priority: "high" } }),
      json("tasks.v2.Task.get", { task: { id: 43 } }),
    ]);
    expect(result).toEqual({ results: [{ taskId: 42, ok: true, priority: "high" }, { taskId: 43, ok: true, priority: "high" }] });
  });

  it("fails a task whose re-read priority is not the written one and goes on with the rest", async () => {
    const { ctx } = fakeCtx(replies(card({}), card({ priority: "average" }), card({}), card({ priority: "high" })));

    const result = await op("task_priority").execute(ctx, { taskIds: [42, 43], priority: "high" });

    expect(result).toEqual({
      results: [
        { taskId: 42, ok: false, error: expect.stringMatching(/не сменилась.*average/) },
        { taskId: 43, ok: true, priority: "high" },
      ],
    });
  });

  it("says the write was sent when the re-read fails", async () => {
    const { ctx } = fakeCtx(replies(card({}), new Error("timeout")));

    const result = await op("task_priority").execute(ctx, { taskIds: [42], priority: "average" });

    expect(result).toEqual({ results: [{ taskId: 42, ok: false, error: expect.stringMatching(/запись отправлена.*timeout/) }] });
  });

  it("rejects a priority other than high or average before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("task_priority").execute(ctx, { taskIds: [42], priority: "low" })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_deadline", () => {
  const DEADLINE = "tasks.v2.Task.Deadline.update";

  it("writes the deadline in unix seconds with the reason and re-reads it", async () => {
    const at = "2026-11-10T06:00:00Z";
    const { ctx, call } = fakeCtx(replies(card({}), card({ deadlineTs: ts(at) })));

    const result = await op("task_deadline").execute(ctx, { taskIds: [42], deadline: "2026-11-10T09:00:00+03:00", reason: "ждём макет" });

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      json(DEADLINE, { task: { id: 42, deadlineTs: ts(at), deadlineChangeReason: "ждём макет" } }),
      json("tasks.v2.Task.get", { task: { id: 42 } }),
    ]);
    expect(result).toEqual({ results: [{ taskId: 42, ok: true, deadline: "2026-11-10T06:00:00.000Z" }] });
  });

  it("clears the deadline with 0 and an empty reason when none is given", async () => {
    const { ctx, call } = fakeCtx(replies(card({}), card({ deadlineTs: null })));

    const result = await op("task_deadline").execute(ctx, { taskIds: [42], deadline: null });

    expect(call.mock.calls[0][0]).toEqual(json(DEADLINE, { task: { id: 42, deadlineTs: 0, deadlineChangeReason: "" } }));
    expect(result).toEqual({ results: [{ taskId: 42, ok: true, deadline: null }] });
  });

  it("takes a deadline stored without the seconds for the written one and fails one a minute off", async () => {
    const { ctx } = fakeCtx(
      replies(card({}), card({ deadlineTs: ts("2026-11-10T06:00:00Z") }), card({}), card({ deadlineTs: ts("2026-11-10T06:01:00Z") })),
    );

    const result = await op("task_deadline").execute(ctx, { taskIds: [42, 43], deadline: "2026-11-10T06:00:45Z" });

    expect(result).toEqual({
      results: [
        { taskId: 42, ok: true, deadline: "2026-11-10T06:00:00.000Z" },
        { taskId: 43, ok: false, error: expect.stringMatching(/срок другой.*06:01/) },
      ],
    });
  });

  it("fails a task whose re-read deadline differs, a card without deadlineTs included", async () => {
    const { ctx } = fakeCtx(replies(card({}), card({ deadlineTs: null }), card({}), card({})));

    const result = await op("task_deadline").execute(ctx, { taskIds: [42, 43], deadline: "2026-11-10T00:00:00Z" });

    expect(result).toEqual({
      results: [
        { taskId: 42, ok: false, error: expect.stringMatching(/срок другой.*нет/) },
        { taskId: 43, ok: false, error: expect.stringMatching(/запись отправлена.*unexpected shape/) },
      ],
    });
  });

  it("rejects a missing deadline, a date without an offset or at the epoch before any request", async () => {
    const { ctx, call } = fakeCtx();

    for (const args of [
      { taskIds: [42] },
      { taskIds: [42], deadline: "2026-11-10T09:00:00" },
      { taskIds: [42], deadline: "1970-01-01T00:00:00Z" },
    ]) {
      await expect(op("task_deadline").execute(ctx, args)).rejects.toThrow(OpInputError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_mute", () => {
  const me = { result: { ID: "7" } };

  it("mutes through the attention controller and finds the current user among the muted", async () => {
    const { ctx, call } = fakeCtx(replies(me, ok, card({ inMute: [3, "7"] })));

    expect(await op("task_mute").execute(ctx, { taskId: "42", muted: true })).toEqual({ taskId: 42, muted: true });
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      rest("/rest/user.current.json", {}),
      json("tasks.v2.Task.Attention.mute", { taskId: 42 }),
      json("tasks.v2.Task.get", { task: { id: 42 } }),
    ]);
  });

  it("unmutes and finds the current user no longer among the muted", async () => {
    const { ctx, call } = fakeCtx(replies(me, ok, card({ inMute: [3] })));

    expect(await op("task_mute").execute(ctx, { taskId: 42, muted: false })).toEqual({ taskId: 42, muted: false });
    expect(call.mock.calls[1][0]).toEqual(json("tasks.v2.Task.Attention.unmute", { taskId: 42 }));
  });

  it("fails when the re-read state is not the requested one", async () => {
    const muting = fakeCtx(replies(me, ok, card({ inMute: [] })));
    await expect(op("task_mute").execute(muting.ctx, { taskId: 42, muted: true })).rejects.toThrow(/по-прежнему включены/);

    const unmuting = fakeCtx(replies(me, ok, card({ inMute: [7] })));
    await expect(op("task_mute").execute(unmuting.ctx, { taskId: 42, muted: false })).rejects.toThrow(/по-прежнему выключены/);
  });

  it("says the write was sent when the card has no inMute", async () => {
    const { ctx } = fakeCtx(replies(me, ok, card({})));

    await expect(op("task_mute").execute(ctx, { taskId: 42, muted: true })).rejects.toThrow(/запись отправлена.*unexpected shape/);
  });
});

const reminder = (fields: Record<string, unknown> = {}) => ({
  id: 61,
  userId: 7,
  taskId: 42,
  nextRemindTs: ts("2026-11-10T06:00:00Z"),
  remindBy: "date",
  remindVia: "notification",
  recipient: "myself",
  rrule: null,
  before: 0,
  ...fields,
});
const list = (...items: unknown[]) => ({ status: "success", data: items });

describe("task_reminders", () => {
  it("lists the reminders with ISO dates", async () => {
    const { ctx, call } = fakeCtx(replies(list(reminder(), reminder({ id: "62", nextRemindTs: null, remindBy: "deadline", remindVia: "email" }))));

    const result = await op("task_reminders").execute(ctx, { taskId: 42 });

    expect(call.mock.calls[0][0]).toEqual(json("tasks.v2.Task.Reminder.list", { taskId: 42 }));
    expect(result).toEqual({
      taskId: 42,
      reminders: [
        { id: 61, at: "2026-11-10T06:00:00.000Z", via: "notification", remindBy: "date", recipient: "myself" },
        { id: 62, at: null, via: "email", remindBy: "deadline", recipient: "myself" },
      ],
    });
  });
});

describe("task_reminder_set", () => {
  const at = "2026-11-10T09:00:00+03:00";
  const atTs = ts("2026-11-10T06:00:00Z");

  it("adds a reminder for the current user and re-reads it from the list", async () => {
    const { ctx, call } = fakeCtx(
      replies({ result: { ID: "7" } }, { status: "success", data: { id: 61 } }, list(reminder({ id: 60 }), reminder({ remindVia: "email" }))),
    );

    const result = await op("task_reminder_set").execute(ctx, { taskId: 42, at, via: "email" });

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      rest("/rest/user.current.json", {}),
      json("tasks.v2.Task.Reminder.add", {
        reminder: {
          id: expect.stringMatching(/^tmp\d+$/),
          taskId: 42,
          userId: 7,
          nextRemindTs: atTs,
          remindBy: "date",
          remindVia: "email",
          recipient: "myself",
          before: 0,
        },
      }),
      json("tasks.v2.Task.Reminder.list", { taskId: 42 }),
    ]);
    expect(result).toEqual({
      taskId: 42,
      reminder: { id: 61, at: "2026-11-10T06:00:00.000Z", via: "email", remindBy: "date", recipient: "myself" },
    });
  });

  it("warns that a reminder may exist when the add answer is not recognised", async () => {
    const { ctx, call } = fakeCtx(replies({ result: { ID: 7 } }, { status: "success", data: null }));

    await expect(op("task_reminder_set").execute(ctx, { taskId: 42, at, via: "notification" })).rejects.toThrow(
      /могло создаться.*bitrix_task_reminders/,
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("updates an existing reminder to a date, keeping its owner and recipient", async () => {
    const existing = reminder({ userId: 9, recipient: "responsible", remindBy: "deadline", before: 3600, nextRemindTs: 1 });
    const { ctx, call } = fakeCtx(
      replies(list(existing), { status: "success", data: { id: 61 } }, list(reminder({ userId: 9, recipient: "responsible" }))),
    );

    const result = await op("task_reminder_set").execute(ctx, { taskId: 42, reminderId: "61", at, via: "notification" });

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      json("tasks.v2.Task.Reminder.list", { taskId: 42 }),
      json("tasks.v2.Task.Reminder.update", {
        reminder: {
          id: 61,
          taskId: 42,
          userId: 9,
          nextRemindTs: atTs,
          remindBy: "date",
          remindVia: "notification",
          recipient: "responsible",
          before: 0,
        },
      }),
      json("tasks.v2.Task.Reminder.list", { taskId: 42 }),
    ]);
    expect(result).toEqual({
      taskId: 42,
      reminder: { id: 61, at: "2026-11-10T06:00:00.000Z", via: "notification", remindBy: "date", recipient: "responsible" },
    });
  });

  it("does not write when the task has no such reminder or the list cannot be read", async () => {
    const missing = fakeCtx(replies(list(reminder({ id: 60 }))));
    await expect(op("task_reminder_set").execute(missing.ctx, { taskId: 42, reminderId: 61, at, via: "email" })).rejects.toThrow(
      /нет напоминания 61.*ничего не изменено/,
    );
    expect(missing.call).toHaveBeenCalledTimes(1);

    const unreadable = fakeCtx(replies({ status: "success", data: null }));
    await expect(op("task_reminder_set").execute(unreadable.ctx, { taskId: 42, reminderId: 61, at, via: "email" })).rejects.toThrow(
      /unexpected shape/,
    );
    expect(unreadable.call).toHaveBeenCalledTimes(1);
  });

  it("takes a reminder stored without the seconds for the written one and fails one a minute off", async () => {
    const same = fakeCtx(replies(list(reminder()), { status: "success", data: { id: 61 } }, list(reminder())));
    const result = await op("task_reminder_set").execute(same.ctx, { taskId: 42, reminderId: 61, at: "2026-11-10T06:00:30Z", via: "notification" });
    expect(result).toEqual({
      taskId: 42,
      reminder: { id: 61, at: "2026-11-10T06:00:00.000Z", via: "notification", remindBy: "date", recipient: "myself" },
    });

    const off = fakeCtx(replies(list(reminder()), { status: "success", data: { id: 61 } }, list(reminder())));
    await expect(
      op("task_reminder_set").execute(off.ctx, { taskId: 42, reminderId: 61, at: "2026-11-10T06:01:00Z", via: "notification" }),
    ).rejects.toThrow(/напоминание 61 другое/);
  });

  it("fails when the re-read reminder is missing or differs from the written one", async () => {
    const gone = fakeCtx(replies({ result: { ID: 7 } }, { status: "success", data: { id: 61 } }, list()));
    await expect(op("task_reminder_set").execute(gone.ctx, { taskId: 42, at, via: "email" })).rejects.toThrow(/напоминания 61 нет/);

    const other = fakeCtx(replies(list(reminder()), { status: "success", data: { id: 61 } }, list(reminder())));
    await expect(op("task_reminder_set").execute(other.ctx, { taskId: 42, reminderId: 61, at, via: "email" })).rejects.toThrow(
      /напоминание 61 другое.*notification/,
    );
  });

  it("says the write was sent when the re-read fails", async () => {
    const { ctx } = fakeCtx(replies(list(reminder()), { status: "success", data: { id: 61 } }, new Error("timeout")));

    await expect(op("task_reminder_set").execute(ctx, { taskId: 42, reminderId: 61, at, via: "email" })).rejects.toThrow(
      /запись отправлена.*timeout/,
    );
  });

  it("rejects a date without an offset or an unknown channel before any request", async () => {
    const { ctx, call } = fakeCtx();

    for (const args of [
      { taskId: 42, at: "2026-11-10T09:00:00", via: "email" },
      { taskId: 42, at: null, via: "email" },
      { taskId: 42, at, via: "sms" },
    ]) {
      await expect(op("task_reminder_set").execute(ctx, args)).rejects.toThrow(OpInputError);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_reminder_delete", () => {
  it("deletes a reminder of the task and re-reads the list", async () => {
    const { ctx, call } = fakeCtx(replies(list(reminder(), reminder({ id: 62 })), ok, list(reminder({ id: 62 }))));

    expect(await op("task_reminder_delete").execute(ctx, { taskId: "42", reminderId: "61" })).toEqual({
      taskId: 42,
      reminderId: 61,
      deleted: true,
    });
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      json("tasks.v2.Task.Reminder.list", { taskId: 42 }),
      json("tasks.v2.Task.Reminder.delete", { reminder: { id: 61 } }),
      json("tasks.v2.Task.Reminder.list", { taskId: 42 }),
    ]);
  });

  it("does not delete a reminder the task does not have", async () => {
    const { ctx, call } = fakeCtx(replies(list(reminder({ id: 62 }))));

    await expect(op("task_reminder_delete").execute(ctx, { taskId: 42, reminderId: 61 })).rejects.toThrow(/нет напоминания 61.*ничего не удалено/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("fails when the reminder is still there after the delete", async () => {
    const { ctx } = fakeCtx(replies(list(reminder()), ok, list(reminder())));

    await expect(op("task_reminder_delete").execute(ctx, { taskId: 42, reminderId: 61 })).rejects.toThrow(/напоминание 61 осталось/);
  });

  it("says the delete was sent when the re-read fails", async () => {
    const { ctx } = fakeCtx(replies(list(reminder()), ok, new Error("timeout")));

    await expect(op("task_reminder_delete").execute(ctx, { taskId: 42, reminderId: 61 })).rejects.toThrow(/запись отправлена.*timeout/);
  });

  it("requires the task id", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("task_reminder_delete").execute(ctx, { reminderId: 61 })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });
});
