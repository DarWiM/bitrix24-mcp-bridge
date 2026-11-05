// Attaching a local file to a task: the file is uploaded to the current user's Disk, then attached.
// It runs in the daemon, so the path is resolved there, not where the agent works.

import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { errorMessage } from "./batch.js";
import { currentUserId } from "./board.js";
import { REST_TASK_GET, numeric, parseResponse, restMethod, reread } from "./calls.js";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";

const STORAGE_LIST = restMethod("disk.storage.getlist");
const UPLOAD = restMethod("disk.folder.uploadfile");
const ATTACH = restMethod("tasks.task.files.attach");

// The upload is a base64 form body: 10 MB of file is about 13 MB on the wire.
const MAX_BYTES = 10 * 1024 * 1024;

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
    .refine((name) => !/[/\\]/.test(name) && name !== "." && name !== "..", "a file name, without path separators");

async function readTaskFiles(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REST_TASK_GET, params: { taskId, select: ["ID", "UF_TASK_WEBDAV_FILES"] } });
  return parseResponse(taskFilesResponse, raw, "tasks.task.get").result.task.ufTaskWebdavFiles ?? [];
}

// Checked before reading: a fifo or a device would block or never end, a huge file would sit in memory.
async function readLocalFile(path: string) {
  if (!isAbsolute(path)) throw new OpInputError(`path должен быть абсолютным (операция выполняется не в твоём рабочем каталоге): ${path}`);
  const info = await stat(path).catch((e: unknown) => {
    const code = e instanceof Error && "code" in e ? e.code : undefined;
    throw new OpInputError(code === "ENOENT" ? `файл не найден: ${path}` : `не удалось открыть ${path}: ${errorMessage(e)}`);
  });
  if (!info.isFile()) throw new OpInputError(`${path} — не обычный файл (каталог, устройство или канал)`);
  if (info.size === 0) throw new OpInputError(`${path} — пустой файл`);
  if (info.size > MAX_BYTES) throw new OpInputError(`${path} — ${info.size} байт, больше предела 10 МБ`);
  const bytes = await readFile(path);
  // The file may have changed since the stat.
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new OpInputError(`${path} изменился во время чтения — повтори`);
  return bytes;
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
      "АБСОЛЮТНЫЙ путь к обычному файлу (не каталогу), не пустому, до 10 МБ. name — имя файла в Битрикс24 " +
      "(необязательно, по умолчанию имя из path; без разделителей пути); если имя на Диске занято, Битрикс24 " +
      "добавит к нему суффикс. Если прикрепить не удалось, файл остаётся на твоём Диске — ошибка назовёт его. " +
      "После записи файлы задачи перечитываются; если вложения нет — ошибка. " +
      "Ответ: { taskId, diskFileId, name, size, attachmentId }.",
    mutating: true,
    // Six requests in a row, one of them a body of up to about 13 MB.
    budget: "long",
    input: { taskId: idArg(), path: z.string().min(1), name: fileNameArg().optional() },
    run: async (ctx, a) => {
      const { taskId } = a;
      const bytes = await readLocalFile(a.path);
      const fileName = a.name ?? basename(a.path);
      // A wrong taskId must fail before the upload, or the file would be left on Disk for nothing.
      await readTaskFiles(ctx, taskId);
      const rootId = await userDiskRoot(ctx);

      const raw = await ctx
        .call({
          ...UPLOAD,
          params: { id: rootId, data: { NAME: fileName }, fileContent: [fileName, bytes.toString("base64")], generateUniqueName: true },
        })
        .catch((e: unknown) => {
          throw new Error(`загрузка на Диск не подтверждена: ${errorMessage(e)} — файл мог остаться в корне твоего Диска, проверь перед повтором`);
        });
      const parsed = uploadResponse.safeParse(raw);
      if (!parsed.success) {
        throw new Error("disk.folder.uploadfile returned an unexpected shape — файл мог загрузиться в корень твоего Диска, проверь перед повтором");
      }
      const disk = parsed.data.result;
      const onDisk = `файл «${disk.NAME}» (id ${disk.ID}) остался в корне твоего Диска`;
      if (disk.SIZE !== bytes.length) {
        throw new Error(`на Диск загружено ${disk.SIZE} байт вместо ${bytes.length} — к задаче не прикреплён, ${onDisk}`);
      }

      const attachRaw = await ctx.call({ ...ATTACH, params: { taskId, fileId: disk.ID } }).catch((e: unknown) => {
        throw new Error(`не удалось прикрепить файл к задаче ${taskId}: ${errorMessage(e)} — ${onDisk}`);
      });
      const attachment = attachResponse.safeParse(attachRaw);
      if (!attachment.success) {
        throw new Error(`tasks.task.files.attach returned an unexpected shape — прикреплён ли файл, проверь через bitrix_task_files; ${onDisk}`);
      }
      const { attachmentId } = attachment.data.result;

      const files = await reread(readTaskFiles(ctx, taskId), "bitrix_task_files");
      if (!files.includes(attachmentId)) throw new Error(`Bitrix ответил успехом, но вложения ${attachmentId} нет у задачи ${taskId}; ${onDisk}`);
      return { taskId, diskFileId: disk.ID, name: disk.NAME, size: bytes.length, attachmentId };
    },
  }),
];
