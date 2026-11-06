import { describe, it, expect, mock } from "bun:test";
import type { CallTarget, DownloadResult } from "../../shared/wire.js";
import { currentUserId, moveToColumn } from "./board.js";
import type { OpContext } from "./operation.js";

function fakeCtx(callFn: (target: CallTarget) => Promise<unknown>) {
  const call = mock(callFn);
  const ctx: OpContext = {
    portal: "d",
    origin: "https://d.bitrix24.ru",
    origins: { d: "https://d.bitrix24.ru" },
    downloadsDir: "/tmp/br24-unused",
    call,
    callBinary: async (): Promise<DownloadResult> => {
      throw new Error("unexpected download");
    },
  };
  return { ctx, call };
}

describe("currentUserId", () => {
  it("reads user.current once per operation call", async () => {
    const first = fakeCtx(async () => ({ result: { ID: "55" } }));
    const second = fakeCtx(async () => ({ result: { ID: "56" } }));

    expect(await currentUserId(first.ctx)).toBe(55);
    expect(await currentUserId(first.ctx)).toBe(55);
    expect(await currentUserId(second.ctx)).toBe(56);
    expect(first.call).toHaveBeenCalledTimes(1);
    expect(first.call.mock.calls[0][0]).toEqual({
      endpoint: "/rest/user.current.json",
      action: null,
      method: "POST",
      bodyType: "form",
      responseType: "json",
      params: {},
    });
  });

  it("fails on an unexpected shape", async () => {
    const { ctx } = fakeCtx(async () => ({ result: {} }));

    await expect(currentUserId(ctx)).rejects.toThrow("user.current returned an unexpected shape");
  });
});

describe("moveToColumn", () => {
  for (const type of ["FINISH", "finish"]) {
    it(`never sends a task into a column of type ${type}: Bitrix would close it past Definition of Done`, async () => {
      const { ctx, call } = fakeCtx(async () => ({ result: true }));

      await expect(moveToColumn(ctx, 42, { id: 60, name: "Готово", type })).rejects.toThrow("колонка «Готово» (60) завершает задачу");
      expect(call).not.toHaveBeenCalled();
    });
  }
});
