import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { mayHaveHappened, numeric, parseResponse, parseTaskCard, reread, v2 } from "./calls.js";

const card = z.object({ result: z.object({ task: z.object({ id: numeric }) }) });

describe("numeric", () => {
  it("takes a number or a digit string and yields a number", () => {
    expect(numeric.parse(42)).toBe(42);
    expect(numeric.parse("42")).toBe(42);
  });

  for (const value of ["", "4 2", "-1", "1.5", null]) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(numeric.safeParse(value).success).toBe(false);
    });
  }
});

describe("parseResponse", () => {
  it("returns the parsed data", () => {
    expect(parseResponse(card, { result: { task: { id: "7" } } }, "tasks.task.get")).toEqual({ result: { task: { id: 7 } } });
  });

  it("names the method when the answer has another shape", () => {
    expect(() => parseResponse(card, { result: [] }, "tasks.task.get")).toThrow("tasks.task.get returned an unexpected shape");
  });
});

describe("parseTaskCard", () => {
  it("returns the parsed card", () => {
    expect(parseTaskCard(card, { result: { task: { id: 7 } } }, "tasks.task.get", 7)).toEqual({ result: { task: { id: 7 } } });
  });

  for (const [title, raw] of [
    ["REST tasks.task.get", { result: [] }],
    ["ajax tasks.task.get", { status: "success", data: [], errors: [] }],
    ["tasks.v2.Task.get", { status: "success", data: null, errors: [] }],
  ] as const) {
    it(`reads the empty answer of ${title} as a deleted or hidden task`, () => {
      expect(() => parseTaskCard(card, raw, "tasks.task.get", 42)).toThrow(
        "задача 42 не найдена или нет доступа (удалена или скрыта от тебя)",
      );
    });
  }

  for (const raw of [{ result: {} }, { result: [{ id: 42 }] }, { data: {} }, null]) {
    it(`keeps the unexpected-shape error for ${JSON.stringify(raw)}`, () => {
      expect(() => parseTaskCard(card, raw, "tasks.task.get", 42)).toThrow("tasks.task.get returned an unexpected shape");
    });
  }
});

describe("mayHaveHappened", () => {
  const added = z.object({ result: numeric });
  const unconfirmed = "сообщение могло уйти — проверь чат";

  it("returns the parsed answer", async () => {
    expect(await mayHaveHappened(Promise.resolve({ result: "5" }), added, "im.message.add", unconfirmed)).toEqual({ result: 5 });
  });

  it("adds what may have happened to a failed request", async () => {
    const write = Promise.reject(new Error("request timed out"));
    await expect(mayHaveHappened(write, added, "im.message.add", unconfirmed)).rejects.toThrow(`request timed out — ${unconfirmed}`);
  });

  it("adds what may have happened to an unexpected answer", async () => {
    await expect(mayHaveHappened(Promise.resolve({ result: [] }), added, "im.message.add", unconfirmed)).rejects.toThrow(
      `im.message.add returned an unexpected shape — ${unconfirmed}`,
    );
  });
});

describe("reread", () => {
  it("passes the value of a re-read through", async () => {
    expect(await reread(Promise.resolve("описание"), "bitrix_task_get_v2")).toBe("описание");
  });

  it("says the write went out when the re-read fails", async () => {
    await expect(reread(Promise.reject(new Error("extension not connected")), "bitrix_task_get_v2")).rejects.toThrow(
      "запись отправлена, но перечитать не удалось (проверь через bitrix_task_get_v2): extension not connected",
    );
  });
});

describe("v2", () => {
  it("targets an ajax action with a JSON body", () => {
    expect(v2("tasks.v2.Task.Deadline.update")).toMatchObject({ action: "tasks.v2.Task.Deadline.update", method: "POST", bodyType: "json" });
  });
});
