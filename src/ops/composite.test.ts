import { describe, it, expect, mock, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallTarget, DownloadResult } from "../../shared/wire.js";
import { z } from "zod";
import { OpInputError, type OpContext, type Operation } from "./operation.js";
import { OPERATIONS } from "./index.js";

const AJAX = "/bitrix/services/main/ajax.php";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "br24-ops-"));
  tempDirs.push(dir);
  return dir;
}

type CallFn = (target: CallTarget, portal?: string) => Promise<unknown>;
type BinaryFn = (target: CallTarget, dest: string, portal?: string) => Promise<DownloadResult>;

function fakeCtx(opts: { call?: CallFn; callBinary?: BinaryFn; downloadsDir?: string } = {}) {
  const call = mock(opts.call ?? (async (): Promise<unknown> => ({})));
  const callBinary = mock(opts.callBinary ?? (async (): Promise<DownloadResult> => { throw new Error("unexpected download"); }));
  const ctx: OpContext = {
    portal: "d",
    origin: "https://d.bitrix24.ru",
    origins: { d: "https://d.bitrix24.ru", e: "https://e.bitrix24.ru" },
    downloadsDir: opts.downloadsDir ?? tempDir(),
    call,
    callBinary,
  };
  return { ctx, call, callBinary };
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

// Composite results are plain JSON objects; reading them back through JSON keeps the tests typed.
async function run(name: string, ctx: OpContext, args: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(await op(name).execute(ctx, args)));
}

function pageWithTranscript(lines: number): string {
  const P = "bx-call-component-call-ai";
  const blocks = Array.from({ length: lines }, (_, i) =>
    `<div class="${P}-decryption-block"><p class="${P}-decryption-block__description">` +
    `<span class="${P}-decryption-block__time">00:${String(i % 60).padStart(2, "0")}—00:${String((i % 60) + 1).padStart(2, "0")}</span>` +
    `<span class="${P}-decryption-block__name">Пётр:</span> Реплика номер ${i} с достаточным количеством текста для набора объёма.</p></div>`,
  ).join("");
  return `<div data-call-id="4242"><h3 class="${P}__resume-title">Синк</h3>` +
    `<div id="TabTranscriptions" class="${P}__tab-details --transcriptions">${blocks}</div></div>`;
}

const callPage = '<div data-call-id="4242"><h3 class="bx-call-component-call-ai__resume-title">Синк</h3></div>';
const html = (text: string) => ({ contentType: "text/html", text });

describe("call_detail", () => {
  it("sends callId for the path template and parses the returned HTML", async () => {
    const { ctx, call } = fakeCtx({ call: async () => html(callPage) });

    const payload = await run("call_detail", ctx, { callId: 4242 });

    expect(call.mock.calls[0][0]).toEqual({
      endpoint: "/call/detail/{callId}",
      action: null,
      method: "GET",
      bodyType: "form",
      responseType: "text",
      params: { IFRAME: "Y", IFRAME_TYPE: "SIDE_SLIDER", callId: 4242 },
    });
    expect(payload).toMatchObject({ id: 4242, title: "Синк" });
  });

  it("lets agent params override the defaults, but never the callId that fills the path", async () => {
    const { ctx, call } = fakeCtx({ call: async () => html(callPage) });

    await run("call_detail", ctx, { callId: 4242, params: { IFRAME: "N", callId: "../../admin" } });

    expect(call.mock.calls[0][0].params).toEqual({ IFRAME: "N", IFRAME_TYPE: "SIDE_SLIDER", callId: 4242 });
  });

  it("rejects a reserved params key before any request", async () => {
    const { ctx, call } = fakeCtx({ call: async () => html(callPage) });

    await expect(op("call_detail").execute(ctx, { callId: 4242, params: { action: "x" } })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric callId before it can reach the path", async () => {
    const { ctx, call } = fakeCtx({ call: async () => html(callPage) });

    await expect(op("call_detail").execute(ctx, { callId: "../1" })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps a short transcript inline", async () => {
    const dir = tempDir();
    const { ctx } = fakeCtx({ call: async () => html(pageWithTranscript(3)), downloadsDir: dir });

    const payload = await run("call_detail", ctx, { callId: 4242 });

    expect(payload.transcript).toHaveLength(3);
    expect(payload.files).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("spills a long transcript to disk and returns the paths", async () => {
    const dir = tempDir();
    const { ctx } = fakeCtx({ call: async () => html(pageWithTranscript(400)), downloadsDir: dir });

    const payload = await run("call_detail", ctx, { callId: 4242 });

    expect(payload.transcript).toEqual([]);
    expect(payload.transcriptCount).toBe(400);
    expect(payload.files.transcript).toBe(join(dir, "call-4242-transcript.txt"));
    expect(payload.files.json).toBe(join(dir, "call-4242.json"));
    const text = readFileSync(payload.files.transcript, "utf8");
    expect(text).toContain("Звонок №4242");
    expect(text.split("\n").filter((l: string) => l.startsWith("[")).length).toBe(400);
    // the archived JSON keeps what the reply dropped
    expect(JSON.parse(readFileSync(payload.files.json, "utf8")).transcript).toHaveLength(400);
  });

  it("forces a file when asked, even for a short transcript", async () => {
    const { ctx } = fakeCtx({ call: async () => html(pageWithTranscript(2)) });

    const payload = await run("call_detail", ctx, { callId: 4242, transcript: "file" });

    expect(payload.transcript).toEqual([]);
    expect(existsSync(payload.files.transcript)).toBe(true);
  });

  it("returns a long transcript inline when explicitly asked", async () => {
    const dir = tempDir();
    const { ctx } = fakeCtx({ call: async () => html(pageWithTranscript(400)), downloadsDir: dir });

    const payload = await run("call_detail", ctx, { callId: 4242, transcript: "inline" });

    expect(payload.transcript).toHaveLength(400);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("drops the transcript entirely for transcript:none", async () => {
    const dir = tempDir();
    const { ctx } = fakeCtx({ call: async () => html(pageWithTranscript(400)), downloadsDir: dir });

    const payload = await run("call_detail", ctx, { callId: 4242, transcript: "none" });

    expect(payload.transcript).toEqual([]);
    expect(payload.files).toBeUndefined();
    expect(payload.transcriptCount).toBe(400); // size still reported
    expect(readdirSync(dir)).toEqual([]);
  });

  it("surfaces a non-text response as an error instead of crashing", async () => {
    const { ctx } = fakeCtx({ call: async () => ({ status: "success", data: {} }) });

    await expect(op("call_detail").execute(ctx, { callId: 4242 })).rejects.toThrow(/responseType/);
  });
});

function callMessage(id: number, callId: number, messageType: string) {
  return { id, authorId: 101, date: "2026-07-23T12:46:33+03:00", params: { COMPONENT_ID: "CallMessage", COMPONENT_PARAMS: { messageType, callId } } };
}

describe("chat_calls", () => {
  it("pages back with filter[lastId] until the history ends", async () => {
    const { ctx, call } = fakeCtx({
      call: replies(
        { data: { messages: [callMessage(5002, 4243, "START")], hasNextPage: true } },
        { data: { messages: [callMessage(5001, 4242, "START")], hasNextPage: false } },
      ),
    });

    const payload = await run("chat_calls", ctx, { chatId: 999 });

    expect(call.mock.calls[0][0]).toEqual({
      endpoint: AJAX,
      action: "im.v2.Chat.Message.tail",
      method: "POST",
      bodyType: "form",
      responseType: "json",
      params: { "order[id]": "DESC", chatId: 999, limit: 50 },
    });
    expect(call.mock.calls[1][0].params["filter[lastId]"]).toBe(5002); // cursor = oldest id of page 1
    expect(payload.calls.map((c: { callId: number }) => c.callId)).toEqual([4243, 4242]);
    expect(payload.reachedHistoryStart).toBe(true);
    expect(payload.scannedPages).toBe(2);
  });

  it("reports an unfinished scan so the agent can continue", async () => {
    const { ctx } = fakeCtx({ call: async () => ({ data: { messages: [callMessage(5002, 4243, "START")], hasNextPage: true } }) });

    const payload = await run("chat_calls", ctx, { chatId: 999, maxPages: 2, limit: 50 });

    expect(payload.reachedHistoryStart).toBe(false);
    expect(payload.oldestScannedMessageId).toBe(5002);
    expect(payload.scannedPages).toBe(2);
  });

  it("lets agent params override the defaults", async () => {
    const { ctx, call } = fakeCtx({ call: async () => ({ data: { messages: [], hasNextPage: false } }) });

    await run("chat_calls", ctx, { chatId: 999, params: { limit: 20, "order[id]": "ASC" } });

    expect(call.mock.calls[0][0].params).toEqual({ "order[id]": "ASC", chatId: 999, limit: 20 });
  });

  it("rejects a reserved params key before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("chat_calls").execute(ctx, { chatId: 999, params: { mode: "class" } })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });

  it("starts from beforeId when continuing a previous scan", async () => {
    const { ctx, call } = fakeCtx({ call: async () => ({ data: { messages: [], hasNextPage: false } }) });

    await op("chat_calls").execute(ctx, { chatId: 999, beforeId: 4999 });

    expect(call.mock.calls[0][0].params["filter[lastId]"]).toBe(4999);
  });
});

const NAVIGATE_ENDPOINT = "/bitrix/services/main/ajax.php?mode=class&c=bitrix%3Aforum.comments&action=navigateComment";

function forumComment(id: number, body = `Комментарий ${id}`): string {
  return `<div class="feed-com-block-cover" bx-mpl-entity-id="${id}" bx-mpl-read-status="old">` +
    `<div class="feed-com-block blog-comment-user-7"><div class="feed-com-user-box">` +
    `<a class="feed-com-name" bx-tooltip-user-id="7">Пётр</a><a class="feed-com-time">4 мая 2025 09:30</a></div>` +
    `<div class="feed-com-text-inner-inner">${body}</div></div></div>`;
}

function commentsPage(ids: number[], withOlder: boolean) {
  const nav = withOlder ? `<a id="TASK_42-7_Xy_page_nav">Предыдущие комментарии</a>` : "";
  return html(
    `<div>${nav}${ids.map((id) => forumComment(id)).join("")}</div>` +
      `<script>new FCList({ EXEMPLAR_ID : '7_Xy', ajax : {"componentName":"bitrix:forum.comments","params":"c2lnbmVk.sig"} });</script>`,
  );
}

function navigatePage(ids: number[], more: boolean) {
  return { status: "success", messageList: ids.map((id) => forumComment(id)).join(""), navigation: more ? "<a>ещё</a>" : "" };
}

describe("task_comments", () => {
  it("reads the first page, then pages back with the signed parameters until the start", async () => {
    const { ctx, call } = fakeCtx({
      call: replies(commentsPage([30, 31], true), navigatePage([20, 21], true), navigatePage([10], false)),
    });

    const payload = await run("task_comments", ctx, { taskId: 42 });

    expect(call.mock.calls[0][0]).toEqual({
      endpoint: "/task/comments/{taskId}/",
      action: null,
      method: "GET",
      bodyType: "form",
      responseType: "text",
      params: { IFRAME: "Y", IFRAME_TYPE: "SIDE_SLIDER", taskId: 42 },
    });
    expect(call.mock.calls[1][0]).toEqual({
      endpoint: NAVIGATE_ENDPOINT,
      action: null,
      method: "POST",
      bodyType: "form",
      responseType: "json",
      params: {
        AJAX_POST: "Y", MODE: "LIST", PAGEN_1: 1, scope: "web", IFRAME: "Y", IFRAME_TYPE: "SIDE_SLIDER",
        ENTITY_XML_ID: "TASK_42", EXEMPLAR_ID: "7_Xy", "FILTER[<ID]": 30, taskId: 42, signedParameters: "c2lnbmVk.sig",
      },
    });
    expect(call.mock.calls[2][0].params["FILTER[<ID]"]).toBe(20);
    expect(payload.comments.map((c: { id: number }) => c.id)).toEqual([10, 20, 21, 30, 31]);
    expect(payload).toMatchObject({ taskId: 42, total: 5, reachedHistoryStart: true, oldestId: 10, scannedPages: 2 });
  });

  it("makes a single request when the first page already holds the whole discussion", async () => {
    const { ctx, call } = fakeCtx({ call: replies(commentsPage([5, 6], false)) });

    const payload = await run("task_comments", ctx, { taskId: 42 });

    expect(call).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({ total: 2, reachedHistoryStart: true, scannedPages: 0 });
  });

  it("stops at maxPages and says where to continue", async () => {
    const { ctx } = fakeCtx({ call: replies(commentsPage([30], true), navigatePage([20], true)) });

    const payload = await run("task_comments", ctx, { taskId: 42, maxPages: 1 });

    expect(payload).toMatchObject({ reachedHistoryStart: false, oldestId: 20, scannedPages: 1 });
  });

  it("continues from beforeId, using the first page only for a fresh signature", async () => {
    const { ctx, call } = fakeCtx({ call: replies(commentsPage([30], true), navigatePage([10], false)) });

    const payload = await run("task_comments", ctx, { taskId: 42, beforeId: 20 });

    expect(call.mock.calls[1][0].params["FILTER[<ID]"]).toBe(20);
    expect(payload.comments.map((c: { id: number }) => c.id)).toEqual([10]);
    expect(payload.reachedHistoryStart).toBe(true);
  });

  it("returns only the latest `limit` comments without paging further than needed", async () => {
    const { ctx, call } = fakeCtx({ call: replies(commentsPage([30, 31, 32], true)) });

    const payload = await run("task_comments", ctx, { taskId: 42, limit: 2 });

    expect(call).toHaveBeenCalledTimes(1);
    expect(payload.comments.map((c: { id: number }) => c.id)).toEqual([31, 32]);
    expect(payload).toMatchObject({ reachedHistoryStart: false, oldestId: 31 });
  });

  it("spills a long discussion to disk and returns the paths", async () => {
    const dir = tempDir();
    const ids = Array.from({ length: 200 }, (_, i) => 1000 + i);
    const { ctx } = fakeCtx({ call: replies(commentsPage(ids, false)), downloadsDir: dir });

    const payload = await run("task_comments", ctx, { taskId: 42 });

    expect(payload.comments).toEqual([]);
    expect(payload.total).toBe(200);
    expect(payload.files).toEqual({ text: join(dir, "task-42-comments.txt"), json: join(dir, "task-42-comments.json") });
    expect(readFileSync(payload.files.text, "utf8")).toContain("#1000 [2025-05-04T09:30] Пётр (id 7): Комментарий 1000");
    expect(JSON.parse(readFileSync(payload.files.json, "utf8")).comments).toHaveLength(200);
  });

  it("keeps a short discussion inline, and honours output:file / output:inline", async () => {
    const dir = tempDir();
    const short = fakeCtx({ call: async () => commentsPage([1], false), downloadsDir: dir });
    expect((await run("task_comments", short.ctx, { taskId: 42 })).comments).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
    expect((await run("task_comments", short.ctx, { taskId: 42, output: "file" })).files).toBeDefined();

    const ids = Array.from({ length: 200 }, (_, i) => 1000 + i);
    const long = fakeCtx({ call: async () => commentsPage(ids, false) });
    expect((await run("task_comments", long.ctx, { taskId: 42, output: "inline" })).comments).toHaveLength(200);
  });

  it("does not claim the whole history when `limit` cut older comments off", async () => {
    const { ctx } = fakeCtx({ call: replies(commentsPage([30, 31, 32], false)) });

    const payload = await run("task_comments", ctx, { taskId: 42, limit: 2 });

    expect(payload).toMatchObject({ total: 2, reachedHistoryStart: false, oldestId: 31 });
  });

  it("gives taskId and beforeId separate schemas, so the tool schema has no $ref", () => {
    const { taskId, beforeId } = op("task_comments").input;
    expect(beforeId).toBeInstanceOf(z.ZodOptional);
    if (beforeId instanceof z.ZodOptional) expect(beforeId.unwrap()).not.toBe(taskId);
  });

  it("rejects a non-numeric taskId or cursor before it can name a file or reach the portal", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("task_comments").execute(ctx, { taskId: "../../escape", output: "file" })).rejects.toThrow(OpInputError);
    await expect(op("task_comments").execute(ctx, { taskId: 42, beforeId: "abc" })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });

  it("surfaces a login page as an error instead of an empty discussion", async () => {
    const { ctx } = fakeCtx({ call: replies(html("<form id='auth'></form>")) });

    await expect(op("task_comments").execute(ctx, { taskId: 42 })).rejects.toThrow(/not a task comments page/);
  });
});

// Stand-in for the daemon: writes the body where it was told and reports what the portal sent.
function downloads(answer: Omit<DownloadResult, "path">): BinaryFn {
  return async (_target, dest) => {
    writeFileSync(dest, "bytes");
    return { ...answer, path: dest };
  };
}

describe("file_download", () => {
  it("streams to a temp file, then names it as the portal did", async () => {
    const dir = tempDir();
    const { ctx, callBinary } = fakeCtx({
      callBinary: downloads({ bytes: 245320, contentType: "image/jpeg", fileName: "image (29).png" }),
      downloadsDir: dir,
    });
    const endpoint = "/bitrix/services/main/ajax.php?action=disk.api.file.download&fileId=180435&fileName=image%20%2829%29.png";

    const payload = await run("file_download", ctx, { url: `https://d.bitrix24.ru${endpoint}` });

    const [target, dest, portal] = callBinary.mock.calls[0];
    expect(target).toEqual({ endpoint, action: null, method: "GET", params: {}, responseType: "binary" });
    expect(portal).toBe("d");
    expect(dest.endsWith(".part")).toBe(true); // never the guessed final name
    expect(payload.path).toBe(join(dir, "image (29).png"));
    expect(payload.bytes).toBe(245320);
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses a repeat download over an existing file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "photo.png"), "already here");
    const { ctx, callBinary } = fakeCtx({
      callBinary: downloads({ bytes: 9, contentType: "image/png", fileName: "photo.png" }),
      downloadsDir: dir,
    });

    await expect(
      op("file_download").execute(ctx, { url: "https://d.bitrix24.ru/bitrix/services/main/ajax.php?action=disk.api.file.download&fileId=1" }),
    ).rejects.toThrow(/already exists/);
    expect(readFileSync(join(dir, "photo.png"), "utf8")).toBe("already here");
    expect(existsSync(callBinary.mock.calls[0][1])).toBe(false); // temp cleaned up
  });

  it("writes straight to an explicit savePath", async () => {
    const dir = tempDir();
    const { ctx, callBinary } = fakeCtx({
      callBinary: downloads({ bytes: 1, contentType: "image/png", fileName: "server-name.png" }),
      downloadsDir: dir,
    });

    const payload = await run("file_download", ctx, {
      url: "https://d.bitrix24.ru/bitrix/services/main/ajax.php?action=disk.api.file.download",
      savePath: join(dir, "chosen.png"),
    });

    expect(callBinary.mock.calls[0][1]).toBe(join(dir, "chosen.png"));
    expect(payload.path).toBe(join(dir, "chosen.png")); // server name ignored on purpose
  });

  it("downloads a link from another configured portal through that portal", async () => {
    const dir = tempDir();
    const { ctx, callBinary } = fakeCtx({
      callBinary: downloads({ bytes: 3, contentType: "application/pdf", fileName: "spec.pdf" }),
      downloadsDir: dir,
    });

    const payload = await run("file_download", ctx, {
      url: "https://e.bitrix24.ru/bitrix/tools/disk/uf.php?attachedId=77&action=download&ncc=1",
    });

    expect(callBinary.mock.calls[0][0].endpoint).toBe("/bitrix/tools/disk/uf.php?attachedId=77&action=download&ncc=1");
    expect(callBinary.mock.calls[0][2]).toBe("e"); // ctx.portal is "d"
    expect(payload.path).toBe(join(dir, "spec.pdf"));
  });

  it("refuses a URL outside the configured portals", async () => {
    const { ctx, call, callBinary } = fakeCtx();

    await expect(op("file_download").execute(ctx, { url: "https://evil.example/payload.exe" })).rejects.toThrow(/not a configured portal/);
    expect(call).not.toHaveBeenCalled();
    expect(callBinary).not.toHaveBeenCalled();
  });
});

describe("call_recording", () => {
  it("resolves the link from the call detail, then downloads it", async () => {
    const audio = "/bitrix/services/main/ajax.php?action=call.Track.download&SITE_ID=s1&signedParameters=sp.sig";
    const page = `<div data-call-id="4242"><div class="bx-call-component-call-ai__call-audio-record" data-audio-src="${audio}"></div></div>`;
    const dir = tempDir();
    const { ctx, call, callBinary } = fakeCtx({
      call: async () => html(page),
      callBinary: downloads({ bytes: 1024, contentType: "audio/ogg", fileName: "Запись звонка N4242.ogg" }),
      downloadsDir: dir,
    });

    const payload = await run("call_recording", ctx, { callId: 4242 });

    expect(call.mock.calls[0][0].endpoint).toBe("/call/detail/{callId}"); // detail first
    expect(callBinary.mock.calls[0][0]).toMatchObject({ endpoint: audio, method: "GET", responseType: "binary" });
    expect(callBinary.mock.calls[0][2]).toBe("d");
    expect(payload.path).toBe(join(dir, "Запись звонка N4242.ogg")); // portal name wins over "ajax.php"
    expect(payload.contentType).toBe("audio/ogg");
  });

  it("refuses a recording link that points at another configured portal", async () => {
    // userinfo syntax: appended to this portal's origin, the path re-targets the link at portal "e".
    const audio = "@e.bitrix24.ru/bitrix/services/main/ajax.php?action=call.Track.download&signedParameters=sp.sig";
    const page = `<div data-call-id="4242"><div data-audio-src="${audio}"></div></div>`;
    const { ctx, callBinary } = fakeCtx({ call: async () => html(page) });

    await expect(op("call_recording").execute(ctx, { callId: 4242 })).rejects.toThrow(/refusing to download from https:\/\/e\.bitrix24\.ru/);
    expect(callBinary).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric callId before any request", async () => {
    const { ctx, call } = fakeCtx();

    await expect(op("call_recording").execute(ctx, { callId: "1a" })).rejects.toThrow(OpInputError);
    expect(call).not.toHaveBeenCalled();
  });

  it("reports calls that were never recorded", async () => {
    const { ctx, call, callBinary } = fakeCtx({ call: async () => html('<div data-call-id="4242"></div>') });

    await expect(op("call_recording").execute(ctx, { callId: 4242 })).rejects.toThrow(/no recording/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(callBinary).not.toHaveBeenCalled(); // no download attempted
  });
});
