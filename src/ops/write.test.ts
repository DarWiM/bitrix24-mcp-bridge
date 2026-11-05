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

describe("write operations in OPERATIONS", () => {
  it("registers all three as mutating", () => {
    for (const name of ["task_description_set", "task_description_append", "chat_send"]) {
      expect(op(name).mutating).toBe(true);
    }
  });

  it("takes no agent params", () => {
    for (const name of ["task_description_set", "task_description_append", "chat_send"]) {
      expect(Object.keys(op(name).input)).not.toContain("params");
    }
  });

  it("refuses each of them before any request when mutations are off", async () => {
    const { ctx, call } = fakeCtx();
    const reg = createRegistry(OPERATIONS);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["task_description_set", { taskId: 1, text: "x" }],
      ["task_description_append", { taskId: 1, text: "x" }],
      ["chat_send", { chatId: 1, text: "x" }],
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
