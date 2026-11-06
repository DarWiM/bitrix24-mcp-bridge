import { describe, it, expect, mock, beforeAll, afterAll, afterEach, setSystemTime } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallTarget, DownloadResult } from "../../shared/wire.js";
import { BUDGET_TIMEOUT_MS, OpInputError, OpRefusedError, UPLOAD_TIMEOUT_MS, type OpContext, type Operation } from "./operation.js";
import { createRegistry, runOperation } from "./registry.js";
import { OPERATIONS } from "./index.js";

type CallFn = (target: CallTarget, portal?: string, opts?: { timeoutMs?: number }) => Promise<unknown>;

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

const rest = (method: string, params: Record<string, unknown>): CallTarget =>
  ({ endpoint: `/rest/${method}.json`, action: null, method: "POST", bodyType: "form", responseType: "json", params });

const CONTENT = "probe body";
const BASE64 = Buffer.from(CONTENT).toString("base64");

const taskFiles = (ids?: number[]) => ({ result: { task: { id: "42", ...(ids ? { ufTaskWebdavFiles: ids } : {}) } } });
const me = { result: { ID: "55" } };
const storages = { result: [{ ID: "69", ENTITY_TYPE: "user", ENTITY_ID: "55", ROOT_OBJECT_ID: "2043" }] };
const uploaded = (fields: Record<string, unknown> = {}) => ({
  result: {
    ID: 207687,
    NAME: "probe.txt",
    SIZE: String(CONTENT.length),
    FILE_ID: "9001",
    PARENT_ID: "2043",
    DOWNLOAD_URL: "https://d.bitrix24.ru/rest/download.json?sessid=secret-sessid&token=t",
    ...fields,
  },
});
const attached = { result: { attachmentId: 22193 } };

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "br24-attach-"));
  file = join(dir, "probe.txt");
  writeFileSync(file, CONTENT);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  setSystemTime();
});

// Replies in order like `replies`, and moves the frozen clock on by `ms` once the request matching `slow` is made.
function slowReplies(slow: string, ms: number, ...pages: unknown[]): CallFn {
  let now = Date.parse("2026-11-06T10:00:00Z");
  setSystemTime(new Date(now));
  const next = replies(...pages);
  return async (target, portal, opts) => {
    if (target.endpoint.includes(slow)) {
      now += ms;
      setSystemTime(new Date(now));
    }
    return next(target, portal, opts);
  };
}

describe("task_file_attach in OPERATIONS", () => {
  it("is mutating, long and takes no agent params", () => {
    const attach = op("task_file_attach");
    expect(attach.mutating).toBe(true);
    expect(attach.budget).toBe("long");
    expect(Object.keys(attach.input)).not.toContain("params");
  });

  it("is refused before any request when mutations are off", async () => {
    const { ctx, call } = fakeCtx();
    const reg = createRegistry(OPERATIONS);
    await expect(runOperation(reg, "task_file_attach", { taskId: 42, path: file }, ctx, { allowMutations: false })).rejects.toThrow(OpRefusedError);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("task_file_attach and the bridge's own directory", () => {
  const saved = process.env.BITRIX24_MCP_BRIDGE_HOME;
  let home: string;

  beforeAll(() => {
    home = join(dir, "bridge-home");
    mkdirSync(join(home, "downloads"), { recursive: true });
    writeFileSync(join(home, "config.json"), '{"token":"secret"}');
    writeFileSync(join(home, "downloads", "report.pdf"), CONTENT);
    symlinkSync(join(home, "config.json"), join(dir, "innocent.txt"));
    symlinkSync(home, join(dir, "home-link"));
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.BITRIX24_MCP_BRIDGE_HOME;
    else process.env.BITRIX24_MCP_BRIDGE_HOME = saved;
  });

  const refused = async (path: string, bridgeHome: string) => {
    process.env.BITRIX24_MCP_BRIDGE_HOME = bridgeHome;
    const { ctx, call } = fakeCtx();
    const attach = op("task_file_attach");
    await expect(attach.execute(ctx, { taskId: 42, path })).rejects.toThrow(OpInputError);
    await expect(attach.execute(ctx, { taskId: 42, path })).rejects.toThrow(/служебном каталоге моста/);
    expect(call).not.toHaveBeenCalled();
  };

  it("refuses its config.json and anything else in it before any request", async () => {
    await refused(join(home, "config.json"), home);
    await refused(join(home, "downloads", "report.pdf"), home);
    await refused(join(home, "downloads", "..", "config.json"), home);
  });

  it("refuses a symlink pointing into it", async () => {
    await refused(join(dir, "innocent.txt"), home);
  });

  it("refuses a file in it when the bridge's home itself is reached through a symlink", async () => {
    await refused(join(home, "config.json"), join(dir, "home-link"));
    await refused(join(dir, "home-link", "config.json"), home);
  });

  it("still attaches a file next to it, outside it", async () => {
    process.env.BITRIX24_MCP_BRIDGE_HOME = home;
    const { ctx, call } = fakeCtx(replies(taskFiles(), me, storages, uploaded(), attached, taskFiles([22193])));

    await op("task_file_attach").execute(ctx, { taskId: 42, path: file });

    expect(call).toHaveBeenCalledTimes(6);
  });
});

describe("task_file_attach", () => {
  it("uploads the file to the user's Disk root, attaches it and re-reads the task's files", async () => {
    // Frozen clock: with no time spent, the upload gets the full ceiling.
    const { ctx, call } = fakeCtx(slowReplies("disk.storage", 0, taskFiles(), me, storages, uploaded(), attached, taskFiles([22193])));

    const result = await op("task_file_attach").execute(ctx, { taskId: "42", path: file });

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      rest("tasks.task.get", { taskId: 42, select: ["ID", "UF_TASK_WEBDAV_FILES"] }),
      rest("user.current", {}),
      rest("disk.storage.getlist", { filter: { ENTITY_TYPE: "user", ENTITY_ID: 55 } }),
      rest("disk.folder.uploadfile", {
        id: 2043,
        data: { NAME: "probe.txt" },
        fileContent: ["probe.txt", BASE64],
        generateUniqueName: true,
      }),
      rest("tasks.task.files.attach", { taskId: 42, fileId: 207687 }),
      rest("tasks.task.get", { taskId: 42, select: ["ID", "UF_TASK_WEBDAV_FILES"] }),
    ]);
    // Only the upload outlives the regular per-request timeout.
    expect(call.mock.calls.map((c) => c[2])).toEqual([undefined, undefined, undefined, { timeoutMs: UPLOAD_TIMEOUT_MS }, undefined, undefined]);
    // Only these fields: the upload reply's DOWNLOAD_URL carries the session id.
    expect(result).toEqual({ taskId: 42, diskFileId: 207687, name: "probe.txt", size: CONTENT.length, attachmentId: 22193 });
  });

  it("uploads under the given name and reports the name Disk gave the file", async () => {
    const { ctx, call } = fakeCtx(
      replies(taskFiles([1]), me, storages, uploaded({ NAME: "report (1).txt" }), attached, taskFiles([1, 22193])),
    );

    const result = await op("task_file_attach").execute(ctx, { taskId: 42, path: file, name: "report.txt" });

    expect(call.mock.calls[3][0].params).toEqual({
      id: 2043,
      data: { NAME: "report.txt" },
      fileContent: ["report.txt", BASE64],
      generateUniqueName: true,
    });
    expect(result).toEqual({ taskId: 42, diskFileId: 207687, name: "report (1).txt", size: CONTENT.length, attachmentId: 22193 });
  });

  it("rejects a relative path before any request", async () => {
    const { ctx, call } = fakeCtx();
    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: "probe.txt" })).rejects.toThrow(OpInputError);
    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: "probe.txt" })).rejects.toThrow(/абсолютн/);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a name with a path separator or a dot name before any request", async () => {
    const { ctx, call } = fakeCtx();
    for (const name of ["a/b.txt", "a\\b.txt", "..", ".", "", "a\u0000b.txt", "a\nb.txt", "a\u007fb.txt"]) {
      await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: file, name })).rejects.toThrow(OpInputError);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a missing file, a directory, a device and an empty file before any request", async () => {
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "");
    const { ctx, call } = fakeCtx();
    const attach = op("task_file_attach");

    await expect(attach.execute(ctx, { taskId: 42, path: join(dir, "missing.txt") })).rejects.toThrow(/не найден/);
    await expect(attach.execute(ctx, { taskId: 42, path: dir })).rejects.toThrow(/не обычный файл/);
    await expect(attach.execute(ctx, { taskId: 42, path: "/dev/null" })).rejects.toThrow(/не обычный файл/);
    await expect(attach.execute(ctx, { taskId: 42, path: empty })).rejects.toThrow(/пуст/);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a fifo without waiting for a writer", async () => {
    const fifo = join(dir, "pipe");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const { ctx, call } = fakeCtx();

    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: fifo })).rejects.toThrow(/не обычный файл/);
    expect(call).not.toHaveBeenCalled();
  });

  it.skipIf(process.getuid?.() === 0)("turns an unreadable file into a readable input error", async () => {
    const locked = join(dir, "locked.txt");
    writeFileSync(locked, CONTENT);
    chmodSync(locked, 0o000);
    const { ctx, call } = fakeCtx();

    const error = await op("task_file_attach").execute(ctx, { taskId: 42, path: locked }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpInputError);
    expect(error instanceof Error ? error.message : "").toMatch(/нет доступа.*locked\.txt/);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a file over 10 MB before any request", async () => {
    const big = join(dir, "big.bin");
    writeFileSync(big, "");
    // Sparse: the size is all stat sees, nothing is written to disk.
    truncateSync(big, 10 * 1024 * 1024 + 1);
    const { ctx, call } = fakeCtx();

    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: big })).rejects.toThrow(/10 МБ/);
    expect(call).not.toHaveBeenCalled();
  });

  it("uploads nothing when the task cannot be read", async () => {
    const { ctx, call } = fakeCtx(replies(new Error("ACCESS_DENIED")));

    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: file })).rejects.toThrow(/ACCESS_DENIED/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("uploads nothing unless the user has exactly one Disk storage", async () => {
    for (const list of [{ result: [] }, { result: [storages.result[0], { ...storages.result[0], ID: "70" }] }]) {
      const { ctx, call } = fakeCtx(replies(taskFiles(), me, list));

      await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: file })).rejects.toThrow(/Диск/);
      expect(call).toHaveBeenCalledTimes(3);
    }
  });

  it("gives the upload what is left of the operation's budget after a reserve for attach and re-read", async () => {
    const { ctx, call } = fakeCtx(slowReplies("disk.storage", 100_000, taskFiles(), me, storages, uploaded(), attached, taskFiles([22193])));

    await op("task_file_attach").execute(ctx, { taskId: 42, path: file });

    expect(call.mock.calls[3][2]).toEqual({ timeoutMs: BUDGET_TIMEOUT_MS.long - 100_000 - 65_000 });
  });

  it("refuses to upload when too little of the operation's budget is left", async () => {
    const { ctx, call } = fakeCtx(slowReplies("disk.storage", 230_000, taskFiles(), me, storages));

    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: file })).rejects.toThrow(/не загружен/);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("says the file may be on Disk when the upload reply is not recognised, without leaking it", async () => {
    const { ctx, call } = fakeCtx(replies(taskFiles(), me, storages, { result: { DOWNLOAD_URL: "https://d/rest/download.json?sessid=secret-sessid" } }));

    const error = await op("task_file_attach").execute(ctx, { taskId: 42, path: file }).catch((e: unknown) => e);

    const message = error instanceof Error ? error.message : "";
    expect(message).toMatch(/unexpected shape.*мог загрузиться на Диск.*probe\.txt.*перед повтором/);
    expect(message).not.toContain("secret-sessid");
    expect(message).not.toContain(BASE64);
    expect(call).toHaveBeenCalledTimes(4);
  });

  it("keeps the file contents out of an upload error and says the file may be on Disk", async () => {
    const { ctx } = fakeCtx(replies(taskFiles(), me, storages, new Error("call disk.folder.uploadfile timed out")));

    const error = await op("task_file_attach").execute(ctx, { taskId: 42, path: file }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toMatch(/timed out/);
    expect(message).toMatch(/мог загрузиться на Диск.*корневую папку Диска.*probe\.txt.*перед повтором/);
    expect(message).not.toContain(BASE64);
    expect(message).not.toContain(CONTENT);
  });

  it("does not attach a file whose uploaded size differs and names it on Disk", async () => {
    const { ctx, call } = fakeCtx(replies(taskFiles(), me, storages, uploaded({ SIZE: "3" })));

    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: file })).rejects.toThrow(/probe\.txt.*207687/);
    expect(call).toHaveBeenCalledTimes(4);
  });

  it("says the attachment may exist and names the Disk file when the attach fails, without retrying", async () => {
    const { ctx, call } = fakeCtx(replies(taskFiles(), me, storages, uploaded(), new Error("call tasks.task.files.attach timed out")));

    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: file })).rejects.toThrow(
      /timed out.*вложение могло создаться.*bitrix_task_files перед повтором.*probe\.txt.*207687.*Диск/,
    );
    expect(call).toHaveBeenCalledTimes(5);
  });

  it("says the attachment may exist and names the Disk file when the attach reply is not recognised", async () => {
    const { ctx, call } = fakeCtx(replies(taskFiles(), me, storages, uploaded(), { result: true }));

    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: file })).rejects.toThrow(
      /unexpected shape.*вложение могло создаться.*bitrix_task_files.*probe\.txt.*207687/,
    );
    expect(call).toHaveBeenCalledTimes(5);
  });

  it("fails when the re-read task does not list the new attachment", async () => {
    const { ctx } = fakeCtx(replies(taskFiles(), me, storages, uploaded(), attached, taskFiles([1])));

    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: file })).rejects.toThrow(/22193/);
  });

  it("says the write was sent when the re-read fails", async () => {
    const { ctx } = fakeCtx(replies(taskFiles(), me, storages, uploaded(), attached, { result: "odd" }));

    await expect(op("task_file_attach").execute(ctx, { taskId: 42, path: file })).rejects.toThrow(
      /запись отправлена, но перечитать не удалось.*probe\.txt.*207687/,
    );
  });
});
