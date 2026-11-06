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
const form = (action: string, params: Record<string, unknown>): CallTarget =>
  ({ endpoint: AJAX, action, method: "POST", bodyType: "form", responseType: "json", params });

const MAY_HAVE_GONE = "сообщение могло уйти, проверь чат (bitrix_chat_messages) перед повтором";

const MUTATING = ["chat_send", "chat_message_edit", "chat_reaction", "task_chat_post"];

describe("chat operations in OPERATIONS", () => {
  it("registers them as mutating, none taking agent params", () => {
    for (const name of MUTATING) {
      expect(op(name).mutating).toBe(true);
      expect(Object.keys(op(name).input)).not.toContain("params");
    }
    expect(op("task_chat_post").budget).toBe("long");
  });

  it("refuses every one before any request when mutations are off", async () => {
    const { ctx, call } = fakeCtx();
    const reg = createRegistry(OPERATIONS);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["chat_send", { chatId: 1, text: "x" }],
      ["chat_message_edit", { messageId: 1, text: "x" }],
      ["chat_reaction", { messageId: 1, reaction: "like" }],
      ["task_chat_post", { taskIds: [1], text: "x" }],
    ];
    for (const [name, args] of calls) {
      const err = await rejection(runOperation(reg, name, args, ctx, { allowMutations: false }));
      expect(err).toBeInstanceOf(OpRefusedError);
    }
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

  it("sends replyTo as REPLY_ID", async () => {
    const { ctx, call } = fakeCtx(async () => ({ result: 1884132 }));

    const result = await op("chat_send").execute(ctx, { chatId: 40271, text: "Да", replyTo: "1884131" });

    expect(call.mock.calls[0][0]).toEqual(
      rest("/rest/im.message.add.json", { DIALOG_ID: "chat40271", MESSAGE: "Да", REPLY_ID: 1884131 }),
    );
    expect(result).toEqual({ chatId: 40271, dialogId: "chat40271", messageId: 1884132 });
  });

  for (const [title, args] of [
    ["both chatId and dialogId", { chatId: 1, dialogId: "chat1", text: "x" }],
    ["neither chatId nor dialogId", { text: "x" }],
    ["a text over 20 000 characters", { chatId: 1, text: "a".repeat(20_001) }],
    ["an empty text", { chatId: 1, text: "" }],
    ["a non-numeric replyTo", { chatId: 1, text: "x", replyTo: "abc" }],
  ] as const) {
    it(`rejects ${title} before any request`, async () => {
      const { ctx, call } = fakeCtx();

      const err = await rejection(op("chat_send").execute(ctx, args));

      expect(err).toBeInstanceOf(OpInputError);
      expect(call).not.toHaveBeenCalled();
    });
  }

  it("warns that the message may have gone when the send fails", async () => {
    const { ctx } = fakeCtx(async () => {
      throw new Error("extension disconnected");
    });

    const err = await rejection(op("chat_send").execute(ctx, { chatId: 1, text: "x" }));

    expect(err.message).toBe(`extension disconnected — ${MAY_HAVE_GONE}`);
  });

  it("warns that the message may have gone when the answer is not recognised", async () => {
    const { ctx } = fakeCtx(async () => ({ result: { id: 5 } }));

    const err = await rejection(op("chat_send").execute(ctx, { chatId: 1, text: "x" }));

    expect(err.message).toBe(`im.message.add returned an unexpected shape — ${MAY_HAVE_GONE}`);
  });

  it("names both addressing fields when the choice is wrong", async () => {
    const { ctx } = fakeCtx();

    const err = await rejection(op("chat_send").execute(ctx, { text: "x" }));

    expect(err.message).toContain("exactly one of chatId / dialogId");
  });
});

describe("chat_message_edit", () => {
  it("sends im.message.update with MESSAGE_ID and MESSAGE", async () => {
    const { ctx, call } = fakeCtx(async () => ({ result: true }));

    const result = await op("chat_message_edit").execute(ctx, { messageId: "1884131", text: "[b]Исправлено[/b]" });

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toEqual(rest("/rest/im.message.update.json", { MESSAGE_ID: 1884131, MESSAGE: "[b]Исправлено[/b]" }));
    expect(result).toEqual({ messageId: 1884131 });
  });

  it("fails when Bitrix answers false", async () => {
    const { ctx } = fakeCtx(async () => ({ result: false }));

    const err = await rejection(op("chat_message_edit").execute(ctx, { messageId: 5, text: "x" }));

    expect(err.message).toContain("не изменил сообщение 5");
  });

  it("fails on an unexpected answer", async () => {
    const { ctx } = fakeCtx(async () => ({ result: { id: 5 } }));

    await expect(op("chat_message_edit").execute(ctx, { messageId: 5, text: "x" })).rejects.toThrow(/unexpected shape/);
  });

  for (const [title, args] of [
    ["an empty text", { messageId: 1, text: "" }],
    ["a whitespace-only text", { messageId: 1, text: " \n " }],
    ["a text of invisible characters only", { messageId: 1, text: "\u200B \u200C\u200D\u2060\uFEFF" }],
    ["a text over 20 000 characters", { messageId: 1, text: "a".repeat(20_001) }],
    ["a non-numeric messageId", { messageId: "1a", text: "x" }],
  ] as const) {
    it(`rejects ${title} before any request`, async () => {
      const { ctx, call } = fakeCtx();

      const err = await rejection(op("chat_message_edit").execute(ctx, args));

      expect(err).toBeInstanceOf(OpInputError);
      expect(call).not.toHaveBeenCalled();
    });
  }
});

describe("chat_reaction", () => {
  it("sends the web chat's reaction form", async () => {
    const { ctx, call } = fakeCtx(async () => ({ status: "success", data: { result: true } }));

    const result = await op("chat_reaction").execute(ctx, { messageId: "1884131", reaction: "whiteHeavyCheckMark" });

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toEqual(form("im.v2.Chat.Message.Reaction.add", { messageId: 1884131, reaction: "whiteHeavyCheckMark" }));
    expect(result).toEqual({ messageId: 1884131, reaction: "whiteHeavyCheckMark" });
  });

  it("passes a reaction name it does not know through", async () => {
    const { ctx, call } = fakeCtx(async () => ({ status: "success", data: { result: true } }));

    await op("chat_reaction").execute(ctx, { messageId: 7, reaction: "laugh" });

    expect(call.mock.calls[0][0].params).toEqual({ messageId: 7, reaction: "laugh" });
  });

  it("fails when Bitrix answers false", async () => {
    const { ctx } = fakeCtx(async () => ({ status: "success", data: { result: false } }));

    const err = await rejection(op("chat_reaction").execute(ctx, { messageId: 7, reaction: "like" }));

    expect(err.message).toContain("не поставил реакцию");
  });

  it("fails on an unexpected answer", async () => {
    const { ctx } = fakeCtx(async () => ({ status: "success", data: null }));

    await expect(op("chat_reaction").execute(ctx, { messageId: 7, reaction: "like" })).rejects.toThrow(/unexpected shape/);
  });

  for (const [title, args] of [
    ["an empty reaction", { messageId: 1, reaction: "" }],
    ["an emoji instead of a reaction name", { messageId: 1, reaction: "👍" }],
    ["a missing messageId", { reaction: "like" }],
  ] as const) {
    it(`rejects ${title} before any request`, async () => {
      const { ctx, call } = fakeCtx();

      const err = await rejection(op("chat_reaction").execute(ctx, args));

      expect(err).toBeInstanceOf(OpInputError);
      expect(call).not.toHaveBeenCalled();
    });
  }
});

describe("task_chat_post", () => {
  const chatGet = (taskId: number) => rest("/rest/tasks.task.get.json", { taskId, select: ["ID", "CHAT_ID"] });
  const post = (chatId: number, text: string) => rest("/rest/im.message.add.json", { DIALOG_ID: `chat${chatId}`, MESSAGE: text });
  const taskChat = (id: number, chatId: unknown) => ({ result: { task: { id: String(id), chatId } } });

  it("reads each task's CHAT_ID and posts the text there, in order", async () => {
    const { ctx, call } = fakeCtx(replies(taskChat(42, "40271"), { result: 1884131 }, taskChat(43, 40272), { result: "1884132" }));

    const result = await op("task_chat_post").execute(ctx, { taskIds: [42, "43"], text: "Готово, [user=11]Пётр[/user]" });

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      chatGet(42),
      post(40271, "Готово, [user=11]Пётр[/user]"),
      chatGet(43),
      post(40272, "Готово, [user=11]Пётр[/user]"),
    ]);
    expect(result).toEqual({
      results: [
        { taskId: 42, ok: true, chatId: 40271, messageId: 1884131 },
        { taskId: 43, ok: true, chatId: 40272, messageId: 1884132 },
      ],
    });
  });

  for (const chatId of [null, 0, "0"]) {
    it(`reports a task with chatId ${JSON.stringify(chatId)} as having no chat and goes on`, async () => {
      const { ctx, call } = fakeCtx(replies(taskChat(42, chatId), taskChat(43, 40272), { result: 9 }));

      const result = await op("task_chat_post").execute(ctx, { taskIds: [42, 43], text: "x" });

      expect(call).toHaveBeenCalledTimes(3);
      expect(result).toEqual({
        results: [
          { taskId: 42, ok: false, error: "у задачи 42 нет чата" },
          { taskId: 43, ok: true, chatId: 40272, messageId: 9 },
        ],
      });
    });
  }

  it("does not post when the read comes back in an unexpected shape", async () => {
    const { ctx, call } = fakeCtx(replies({ result: { task: { id: "42" } } }));

    const result = await op("task_chat_post").execute(ctx, { taskIds: [42], text: "x" });

    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ results: [{ taskId: 42, ok: false, error: "tasks.task.get returned an unexpected shape" }] });
  });

  it("keeps going after a failed post and warns that the message may have gone", async () => {
    const { ctx } = fakeCtx(replies(taskChat(42, 1), new Error("timeout"), taskChat(43, 2), { result: 10 }));

    const result = await op("task_chat_post").execute(ctx, { taskIds: [42, 43], text: "x" });

    expect(result).toEqual({
      results: [
        { taskId: 42, ok: false, error: `timeout — ${MAY_HAVE_GONE}` },
        { taskId: 43, ok: true, chatId: 2, messageId: 10 },
      ],
    });
  });

  it("warns that the message may have gone when the post answer is not recognised", async () => {
    const { ctx } = fakeCtx(replies(taskChat(42, 1), { result: null }));

    const result = await op("task_chat_post").execute(ctx, { taskIds: [42], text: "x" });

    expect(result).toEqual({
      results: [{ taskId: 42, ok: false, error: `im.message.add returned an unexpected shape — ${MAY_HAVE_GONE}` }],
    });
  });

  for (const [title, args] of [
    ["an empty text", { taskIds: [1], text: "" }],
    ["a text over 20 000 characters", { taskIds: [1], text: "a".repeat(20_001) }],
    ["no tasks", { taskIds: [], text: "x" }],
    ["the same task twice", { taskIds: [1, "1"], text: "x" }],
  ] as const) {
    it(`rejects ${title} before any request`, async () => {
      const { ctx, call } = fakeCtx();

      const err = await rejection(op("task_chat_post").execute(ctx, args));

      expect(err).toBeInstanceOf(OpInputError);
      expect(call).not.toHaveBeenCalled();
    });
  }
});
