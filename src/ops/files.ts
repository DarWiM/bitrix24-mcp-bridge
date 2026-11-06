// Attaching a local file to a task: the file is uploaded to the current user's Disk, then attached.
// It runs in the daemon, so the path is resolved there, not where the agent works.

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { runtimePaths } from "../paths.js";
import { errorMessage } from "./batch.js";
import { currentUserId } from "./board.js";
import { REST_TASK_GET, mayHaveHappened, numeric, parseResponse, restMethod, reread } from "./calls.js";
import { BUDGET_TIMEOUT_MS, OpInputError, UPLOAD_TIMEOUT_MS, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";

const STORAGE_LIST = restMethod("disk.storage.getlist");
const UPLOAD = restMethod("disk.folder.uploadfile");
const ATTACH = restMethod("tasks.task.files.attach");

// The upload is a base64 form body: 10 MB of file is about 13 MB on the wire.
const MAX_BYTES = 10 * 1024 * 1024;
// Attach and re-read after the upload, at the daemon's regular per-request timeout each, plus slack
// so that the daemon answers before the client's own timeout.
const AFTER_UPLOAD_MS = 65_000;
// Less than one regular request's worth is not worth starting a 13 MB upload with.
const MIN_UPLOAD_MS = 30_000;

const storagesResponse = z.object({ result: z.array(z.object({ ROOT_OBJECT_ID: numeric })) });
// Picked out field by field: the reply's DOWNLOAD_URL carries the session id.
const uploadResponse = z.object({ result: z.object({ ID: numeric, NAME: z.string(), SIZE: numeric }) });
const attachResponse = z.object({ result: z.object({ attachmentId: numeric }) });
// The key is absent while a task has no files.
const taskFilesResponse = z.object({ result: z.object({ task: z.object({ ufTaskWebdavFiles: z.array(numeric).optional() }) }) });

const fileNameArg = () =>
  z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !/[/\\\x00-\x1f\x7f]/.test(name) && name !== "." && name !== "..", "a file name, without path separators or control characters");

async function readTaskFiles(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REST_TASK_GET, params: { taskId, select: ["ID", "UF_TASK_WEBDAV_FILES"] } });
  return parseResponse(taskFilesResponse, raw, "tasks.task.get").result.task.ufTaskWebdavFiles ?? [];
}

function fileError(path: string, e: unknown) {
  const code = e instanceof Error && "code" in e ? e.code : undefined;
  if (code === "ENOENT") return new OpInputError(`файл не найден: ${path}`);
  if (code === "EACCES" || code === "EPERM") return new OpInputError(`нет доступа к файлу ${path}`);
  return new OpInputError(`не удалось прочитать ${path}${typeof code === "string" ? ` (${code})` : ""}`);
}

// The bridge's own directory holds config.json with the extension's token. Both sides resolved:
// symlinks, `..` and, on a case-insensitive disk, another spelling must not lead into it.
async function inBridgeHome(realFile: string) {
  const { home } = runtimePaths(process.env);
  const realHome = await realpath(home).catch(() => resolve(home));
  const rel = relative(realHome, realFile);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// One descriptor for the checks and the read, so that the file read is the file checked: the
// resolved path is opened without following a symlink swapped in since.
// Non-blocking: opening a fifo would otherwise wait for a writer; a fifo or a device is refused by
// the stat anyway, and a huge file is never read.
async function readLocalFile(path: string) {
  if (!isAbsolute(path)) throw new OpInputError(`path должен быть абсолютным (операция выполняется не в твоём рабочем каталоге): ${path}`);
  const real = await realpath(path).catch((e: unknown) => {
    throw fileError(path, e);
  });
  if (await inBridgeHome(real)) {
    throw new OpInputError(
      `${path} — в служебном каталоге моста (там его настройки и токен), оттуда файлы не прикрепляются; ` +
        "скачанный мостом файл сначала скопируй в другое место",
    );
  }
  const fh = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch((e: unknown) => {
    throw fileError(path, e);
  });
  try {
    const info = await fh.stat().catch((e: unknown) => {
      throw fileError(path, e);
    });
    if (!info.isFile()) throw new OpInputError(`${path} — не обычный файл (каталог, устройство или канал)`);
    if (info.size === 0) throw new OpInputError(`${path} — пустой файл`);
    if (info.size > MAX_BYTES) throw new OpInputError(`${path} — ${info.size} байт, больше предела 10 МБ`);
    // One byte of room past the stat size tells a file that grew since from one that did not.
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await fh.read(bytes, length, bytes.length - length, length).catch((e: unknown) => {
        throw fileError(path, e);
      });
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new OpInputError(`${path} изменился во время чтения — повтори`);
    return bytes.subarray(0, length);
  } finally {
    // A failed close must not replace the error that ended the read.
    await fh.close().catch(() => {});
  }
}

// The MCP client gives up after the "long" budget: the upload must end in time for the daemon,
// not the client, to report how it went.
function uploadTimeout(startedAt: number) {
  const left = BUDGET_TIMEOUT_MS.long - (Date.now() - startedAt) - AFTER_UPLOAD_MS;
  if (left < MIN_UPLOAD_MS) throw new Error("до конца времени операции осталось слишком мало для загрузки — файл не загружен, повтори");
  return Math.min(left, UPLOAD_TIMEOUT_MS);
}

async function userDiskRoot(ctx: OpContext) {
  const userId = await currentUserId(ctx);
  const raw = await ctx.call({ ...STORAGE_LIST, params: { filter: { ENTITY_TYPE: "user", ENTITY_ID: userId } } });
  const storages = parseResponse(storagesResponse, raw, "disk.storage.getlist").result;
  if (storages.length !== 1) throw new Error(`у пользователя ${userId} ${storages.length} хранилищ Диска вместо одного — файл не загружен`);
  return storages[0].ROOT_OBJECT_ID;
}

export const FILE_OPERATIONS: Operation[] = [
  defineOperation({
    name: "task_file_attach",
    description:
      "⚠ МУТИРУЮЩИЙ. Прикрепить ЛОКАЛЬНЫЙ файл к задаче taskId. Файл УХОДИТ С МАШИНЫ: он загружается в корень " +
      "твоего Диска Битрикс24, затем прикрепляется к задаче — его увидят и смогут скачать все, кто видит задачу. " +
      "Прикрепляй только то, что пользователь явно попросил; любой другой файл — сначала спроси. path — " +
      "АБСОЛЮТНЫЙ путь к обычному файлу (не каталогу), не пустому, до 10 МБ; файлы из служебного каталога моста " +
      "(~/.bitrix24-mcp-bridge, и downloads/ в нём) не прикрепляются. name — имя файла в Битрикс24 " +
      "(необязательно, по умолчанию имя из path; без разделителей пути); если имя на Диске занято, Битрикс24 " +
      "добавит к нему суффикс. Нужно право прикреплять файлы к задаче: тому, кто задачу только видит, " +
      "Битрикс24 может отказать уже после загрузки. Если прикрепить не удалось, файл остаётся на твоём Диске — " +
      "ошибка назовёт его (имя и id). " +
      "После записи файлы задачи перечитываются; если вложения нет — ошибка. " +
      "Ответ: { taskId, diskFileId, name, size, attachmentId }.",
    mutating: true,
    // Six requests in a row; the upload alone may take UPLOAD_TIMEOUT_MS.
    budget: "long",
    input: { taskId: idArg(), path: z.string().min(1), name: fileNameArg().optional() },
    run: async (ctx, a) => {
      const startedAt = Date.now();
      const { taskId } = a;
      const bytes = await readLocalFile(a.path);
      const fileName = a.name ?? basename(a.path);
      // A wrong taskId must fail before the upload, or the file would be left on Disk for nothing.
      await readTaskFiles(ctx, taskId);
      const rootId = await userDiskRoot(ctx);

      const mayBeOnDisk = `файл мог загрузиться на Диск — проверь корневую папку Диска (имя «${fileName}», возможно с суффиксом) перед повтором`;
      const upload = { id: rootId, data: { NAME: fileName }, fileContent: [fileName, bytes.toString("base64")], generateUniqueName: true };
      const uploading = ctx.call({ ...UPLOAD, params: upload }, ctx.portal, { timeoutMs: uploadTimeout(startedAt) });
      const disk = (await mayHaveHappened(uploading, uploadResponse, "disk.folder.uploadfile", mayBeOnDisk)).result;
      const onDisk = `файл «${disk.NAME}» (id ${disk.ID}) — в корне твоего Диска`;
      if (disk.SIZE !== bytes.length) {
        throw new Error(`на Диск загружено ${disk.SIZE} байт вместо ${bytes.length} — к задаче не прикреплён, ${onDisk}`);
      }

      const mayBeAttached = `вложение могло создаться — проверь bitrix_task_files перед повтором; ${onDisk}`;
      const attaching = ctx.call({ ...ATTACH, params: { taskId, fileId: disk.ID } });
      const { attachmentId } = (await mayHaveHappened(attaching, attachResponse, "tasks.task.files.attach", mayBeAttached)).result;

      const files = await reread(readTaskFiles(ctx, taskId), "bitrix_task_files").catch((e: unknown) => {
        throw new Error(`${errorMessage(e)}; ${onDisk}`);
      });
      if (!files.includes(attachmentId)) throw new Error(`Bitrix ответил успехом, но вложения ${attachmentId} нет у задачи ${taskId}; ${onDisk}`);
      return { taskId, diskFileId: disk.ID, name: disk.NAME, size: bytes.length, attachmentId };
    },
  }),
];
