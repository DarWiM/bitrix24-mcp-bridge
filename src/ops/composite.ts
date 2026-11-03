// Operations that take more than one request or parse a server-rendered page. Their results are
// built here rather than passed through from the portal.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DownloadResult } from "../../shared/wire.js";
import { formatTranscript, parseCallDetail, type CallDetail } from "./callDetail.js";
import { collectChatCalls, readMessagePage, sortCalls, type ChatCall } from "./chatCalls.js";
import { fileNameFromUrl, finalizeDownload, resolveDestination, resolvePortalUrl, tempDownloadPath } from "./download.js";
import { agentParams, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { CHAT_MESSAGES_TAIL, callTarget } from "./read.js";
import { formatComments, parseComments, parseFirstPage, type TaskComment } from "./taskComments.js";

// The call analysis and the legacy comments live in server-rendered sliders (HTML), hence "text".
const CALL_DETAIL = callTarget({
  endpoint: "/call/detail/{callId}",
  method: "GET",
  params: { IFRAME: "Y", IFRAME_TYPE: "SIDE_SLIDER" },
  responseType: "text",
});
const TASK_COMMENTS_PAGE = callTarget({
  endpoint: "/task/comments/{taskId}/",
  method: "GET",
  params: { IFRAME: "Y", IFRAME_TYPE: "SIDE_SLIDER" },
  responseType: "text",
});
const TASK_COMMENTS_NAVIGATE = callTarget({
  endpoint: "/bitrix/services/main/ajax.php?mode=class&c=bitrix%3Aforum.comments&action=navigateComment",
  method: "POST",
  params: { AJAX_POST: "Y", MODE: "LIST", PAGEN_1: 1, scope: "web", IFRAME: "Y", IFRAME_TYPE: "SIDE_SLIDER" },
});

const textResponse = z.object({ text: z.string() });
const navigateResponse = z.object({ messageList: z.string(), navigation: z.string().optional() });

// A long meeting's transcript dwarfs everything else in the payload (a 1-hour call: ~70 KB of
// 80 KB). Past this size it goes to disk, where the agent can grep it instead of paying for
// all 333 utterances to find three.
const TRANSCRIPT_INLINE_LIMIT = 20_000;
const TRANSCRIPT_MODES = ["auto", "inline", "file", "none"] as const;
type TranscriptMode = (typeof TRANSCRIPT_MODES)[number];

function shouldSpill(mode: TranscriptMode, call: CallDetail): boolean {
  if (mode === "none" || mode === "inline") return false;
  if (mode === "file") return true;
  return JSON.stringify(call.transcript).length > TRANSCRIPT_INLINE_LIMIT;
}

// Same reasoning as the transcript: a long legacy discussion goes to disk, where it can be grepped.
const COMMENTS_INLINE_LIMIT = 20_000;
const COMMENTS_OUTPUT_MODES = ["auto", "inline", "file"] as const;

async function loadCallDetail(ctx: OpContext, callId: number, extra: Record<string, unknown> | undefined, transcript: boolean) {
  // callId goes last: it fills the path template, so agent params must not swap in an unchecked one.
  const raw = await ctx.call({ ...CALL_DETAIL, params: { ...CALL_DETAIL.params, ...(extra ?? {}), callId } });
  const page = textResponse.safeParse(raw);
  if (!page.success) throw new Error("call detail did not come back as text (responseType \"text\")");
  return parseCallDetail(page.data.text, { origin: ctx.origin, transcript });
}

// The portal mints signed, single-file URLs, so downloads take a URL and check it instead of
// naming a request. The body never enters the agent's context: it is streamed to disk. The
// download runs through the portal the link belongs to, chosen among `origins`.
async function downloadToDisk(ctx: OpContext, origins: Record<string, string>, args: {
  url: string;
  savePath?: string;
  overwrite?: boolean;
  fallbackName: string;
}): Promise<DownloadResult> {
  const target = resolvePortalUrl(args.url, origins);
  // With no savePath the final name is unknown until the portal answers, so the body lands
  // in a temp file and is moved into place afterwards (see finalizeDownload).
  const explicitPath = args.savePath !== undefined
    ? resolveDestination({ savePath: args.savePath, downloadsDir: ctx.downloadsDir, suggestedName: args.fallbackName, overwrite: args.overwrite })
    : null;
  const done = await ctx.callBinary(
    { endpoint: target.endpoint, action: null, method: "GET", params: {}, responseType: "binary" },
    explicitPath ?? tempDownloadPath(ctx.downloadsDir),
    target.portal,
  );
  if (explicitPath) return done;
  return {
    ...done,
    path: finalizeDownload({
      tempPath: done.path,
      serverName: done.fileName,
      fallbackName: fileNameFromUrl(args.url, args.fallbackName),
      downloadsDir: ctx.downloadsDir,
      overwrite: args.overwrite,
    }),
  };
}

export const COMPOSITE_OPERATIONS: Operation[] = [
  defineOperation({
    name: "call_detail",
    description:
      "ВСЁ по видеозвонку/созвону по его callId: тема, дата, длительность, участники (доля " +
      "разговора, оценка, рекомендации), оценка встречи, решения («что решили»), задачи с " +
      "исполнителями, резюме по главам с таймкодами, ПОЛНАЯ РАСШИФРОВКА по репликам и ссылка на " +
      "аудиозапись. callId берётся из системного сообщения чата «Начат звонок №N» (см. " +
      "bitrix_chat_calls) или из ссылки /call/detail/<callId>. " +
      "ДЛИННАЯ расшифровка по умолчанию НЕ приходит в ответе, а сохраняется на диск: тогда " +
      "transcript пуст, а пути лежат в files — files.transcript (текст, строка = реплика с " +
      "таймкодом и спикером: удобно грепать и читать кусками) и files.json (полный ответ). " +
      "transcript: \"inline\" — вернуть расшифровку в ответе (может быть очень объёмной), " +
      "\"file\" — всегда в файл, \"none\" — не нужна вовсе, \"auto\" (умолчание) — по размеру. " +
      "Требует, чтобы у пользователя был доступ к звонку.",
    mutating: false,
    budget: "long",
    input: {
      callId: idArg(),
      transcript: z.enum(TRANSCRIPT_MODES).optional(),
      params: agentParams(),
    },
    async run(ctx, a) {
      const mode = a.transcript ?? "auto";
      const call = await loadCallDetail(ctx, a.callId, a.params, mode !== "none");
      if (!shouldSpill(mode, call)) return call;

      mkdirSync(ctx.downloadsDir, { recursive: true });
      const files = {
        transcript: join(ctx.downloadsDir, `call-${call.id}-transcript.txt`),
        json: join(ctx.downloadsDir, `call-${call.id}.json`),
      };
      writeFileSync(files.transcript, formatTranscript(call), "utf8");
      // The JSON copy keeps the transcript — it is the archive, not the context-sized reply.
      writeFileSync(files.json, JSON.stringify(call, null, 1), "utf8");
      return { ...call, transcript: [], files };
    },
  }),
  // The legacy forum discussion tasks had before task chats. The first page is a server-rendered
  // slider that also mints the signed parameters navigateComment needs.
  defineOperation({
    name: "task_comments",
    description:
      "СТАРЫЕ комментарии задачи (форум) — обсуждение, которое было у задачи до перехода на чаты задач. " +
      "Признак: у задачи COMMENTS_COUNT > 0 (bitrix_task_get с params.select), а в чате задачи " +
      "(CHAT_ID → bitrix_chat_load) только системное сообщение «Чтобы прочитать комментарии, которые " +
      "ранее оставили…». Отдаёт комментарии по порядку (старые → новые): { id, authorId, author, date, " +
      "dateIso, text, isNew, system, files[] }; system: true — служебные (смена срока, «назначены " +
      "исполнителем», пинги); files[].url — ссылка для bitrix_file_download. НИЧЕГО не помечает " +
      "прочитанным. Сам листает до начала истории (maxPages, по умолчанию 10); если в ответе " +
      "reachedHistoryStart:false — продолжи с beforeId: <oldestId>. limit — вернуть только N последних. " +
      "ДЛИННОЕ обсуждение по умолчанию сохраняется на диск: тогда comments пуст, а пути в files — " +
      "files.text (строка = комментарий с id, датой и автором — удобно грепать) и files.json. " +
      "output: \"inline\" — всегда в ответе, \"file\" — всегда в файл, \"auto\" (умолчание) — по размеру.",
    mutating: false,
    budget: "long",
    input: {
      taskId: idArg(),
      limit: z.number().int().positive().optional(),
      maxPages: z.number().int().positive().optional(),
      beforeId: idArg().optional(),
      output: z.enum(COMMENTS_OUTPUT_MODES).optional(),
    },
    async run(ctx, { taskId, limit, maxPages, beforeId, output }) {
      const raw = await ctx.call({ ...TASK_COMMENTS_PAGE, params: { ...TASK_COMMENTS_PAGE.params, taskId } });
      const page = textResponse.safeParse(raw);
      if (!page.success) throw new Error("task comments page did not come back as text (responseType \"text\")");
      const first = parseFirstPage(page.data.text, ctx.origin);

      const byId = new Map<number, TaskComment>();
      const before = beforeId ?? null;
      // Continuing a previous run: the first page is fetched only for its fresh signature.
      if (before === null) for (const c of first.comments) byId.set(c.id, c);
      let cursor = before ?? (first.comments[0]?.id ?? null);
      let reachedHistoryStart = before === null && !first.hasOlder;
      let scannedPages = 0;
      while (!reachedHistoryStart && cursor !== null && scannedPages < (maxPages ?? 10)) {
        if (limit !== undefined && byId.size >= limit) break;
        const rawNav = await ctx.call({
          ...TASK_COMMENTS_NAVIGATE,
          params: {
            ...TASK_COMMENTS_NAVIGATE.params,
            ENTITY_XML_ID: `TASK_${taskId}`,
            EXEMPLAR_ID: first.exemplarId,
            "FILTER[<ID]": cursor,
            taskId,
            signedParameters: first.signedParameters,
          },
        });
        const nav = navigateResponse.safeParse(rawNav);
        if (!nav.success) throw new Error("task comments navigation returned an unexpected shape (no messageList)");
        scannedPages += 1;
        const older = parseComments(nav.data.messageList, ctx.origin).filter((c) => !byId.has(c.id));
        for (const c of older) byId.set(c.id, c);
        if (older.length > 0) cursor = older[0].id;
        // navigation carries the "load more" markup; it is empty once the oldest comment is in.
        if (older.length === 0 || !nav.data.navigation?.trim()) reachedHistoryStart = true;
      }

      const loaded = [...byId.values()].sort((a, b) => a.id - b.id);
      const comments = limit !== undefined ? loaded.slice(-limit) : loaded;
      // Older comments cut off by `limit` are not "the start of history" from the caller's side.
      if (comments.length < loaded.length) reachedHistoryStart = false;
      const result = {
        taskId,
        total: comments.length,
        reachedHistoryStart,
        oldestId: comments[0]?.id ?? null,
        scannedPages,
        comments,
      };

      const mode = output ?? "auto";
      const spill = mode === "file" || (mode === "auto" && JSON.stringify(comments).length > COMMENTS_INLINE_LIMIT);
      if (!spill) return result;

      mkdirSync(ctx.downloadsDir, { recursive: true });
      const files = {
        text: join(ctx.downloadsDir, `task-${taskId}-comments.txt`),
        json: join(ctx.downloadsDir, `task-${taskId}-comments.json`),
      };
      writeFileSync(files.text, formatComments(taskId, comments, reachedHistoryStart), "utf8");
      writeFileSync(files.json, JSON.stringify(result, null, 1), "utf8");
      return { ...result, comments: [], files };
    },
  }),
  defineOperation({
    name: "file_download",
    description:
      "Скачать ФАЙЛ с портала на диск: вложение чата (фото/видео/документ), файл задачи, " +
      "аудиозапись звонка. url — готовая ссылка из ответа моста: files[].urlDownload у " +
      "bitrix_chat_load, ссылки из bitrix_task_files, recording.url у bitrix_call_detail. " +
      "Скачать может только браузерная сессия, поэтому качает расширение; содержимое файла в " +
      "ответ НЕ попадает — возвращается путь на диске. По умолчанию кладёт в " +
      "~/.bitrix24-mcp-bridge/downloads/; savePath — свой путь (абсолютный либо имя файла " +
      "внутри папки загрузок), overwrite: true — перезаписать существующий.",
    mutating: false,
    budget: "download",
    input: { url: z.string(), savePath: z.string().optional(), overwrite: z.boolean().optional() },
    run: (ctx, a) => downloadToDisk(ctx, ctx.origins, { ...a, fallbackName: "bitrix-file" }),
  }),
  defineOperation({
    name: "call_recording",
    description:
      "Скачать АУДИОЗАПИСЬ созвона по callId: сам находит ссылку в деталях звонка и сохраняет " +
      "файл на диск (в ответ возвращается путь, не содержимое). Записи есть не у всех звонков — " +
      "если её нет, вернётся понятная ошибка. savePath/overwrite — как в bitrix_file_download.",
    mutating: false,
    budget: "download",
    input: { callId: idArg(), savePath: z.string().optional(), overwrite: z.boolean().optional() },
    async run(ctx, { callId, savePath, overwrite }) {
      const detail = await loadCallDetail(ctx, callId, undefined, false);
      if (!detail.recording?.url) throw new Error(`call ${callId} has no recording`);
      // The link comes from this portal's own page, so it must point back at this portal.
      return downloadToDisk(ctx, { [ctx.portal]: ctx.origin }, { url: detail.recording.url, savePath, overwrite, fallbackName: `call-${detail.id}.mp3` });
    },
  }),
  defineOperation({
    name: "chat_calls",
    description:
      "Найти ЗВОНКИ/СОЗВОНЫ в чате: листает историю назад и собирает системные сообщения «Начат " +
      "звонок №N» вместе с привязанным резюме BitrixGPT. Отдаёт callId — их скармливай " +
      "bitrix_call_detail. Поиска звонков по порталу целиком нет, поэтому ищи в конкретном чате: " +
      "chatId проекта — bitrix_project_get → CHAT_ID, чат задачи — CHAT_ID из bitrix_task_get. " +
      "Просматривает maxPages страниц по 50 сообщений (по умолчанию 6 ≈ 300 сообщений); если в " +
      "ответе reachedHistoryStart:false, история НЕ дочитана до конца — продолжай с " +
      "beforeId: <oldestScannedMessageId> или увеличь maxPages.",
    mutating: false,
    budget: "long",
    input: {
      chatId: z.union([z.number(), z.string()]),
      limit: z.number().optional(),
      maxPages: z.number().optional(),
      beforeId: z.union([z.number(), z.string()]).optional(),
      params: agentParams(),
    },
    async run(ctx, { chatId, limit, maxPages, beforeId, params }) {
      // The scan owns the chat, the page size and the cursor: agent params cannot redirect or
      // desync it. Continuing a scan is what beforeId is for.
      const { "filter[lastId]": _agentCursor, ...extra } = params ?? {};
      const wanted = limit ?? 20;
      const pageBudget = maxPages ?? 6;
      const found = new Map<number, ChatCall>();
      let cursor: number | string | null = beforeId ?? null;
      let scannedPages = 0;
      let scannedMessages = 0;
      let reachedHistoryStart = false;
      while (scannedPages < pageBudget) {
        const raw = await ctx.call({
          ...CHAT_MESSAGES_TAIL,
          params: {
            ...CHAT_MESSAGES_TAIL.params,
            ...extra,
            chatId,
            limit: 50,
            ...(cursor !== null ? { "filter[lastId]": cursor } : {}),
          },
        });
        const page = readMessagePage(raw);
        collectChatCalls(page.messages, found);
        scannedPages += 1;
        scannedMessages += page.messages.length;
        cursor = page.oldestId;
        if (!page.hasNextPage || page.oldestId === null) {
          reachedHistoryStart = true;
          break;
        }
        if (found.size >= wanted) break;
      }
      return {
        chatId,
        calls: sortCalls(found).slice(0, wanted),
        scannedPages,
        scannedMessages,
        oldestScannedMessageId: cursor,
        reachedHistoryStart,
      };
    },
  }),
];
