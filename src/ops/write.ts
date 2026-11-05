// Operations that change task content or post messages.
// None of them takes agent `params`: merged-in fields could widen a write beyond what the tool
// says it does.

import { z } from "zod";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { TASK_V2_GET, callTarget } from "./read.js";

const restMethod = (method: string) => callTarget({ endpoint: `/rest/${method}.json`, method: "POST" });

const TASK_UPDATE = restMethod("tasks.task.update");
const MESSAGE_ADD = restMethod("im.message.add");

const DESCRIPTION_MAX = 100_000;
// Bitrix's documented message limit; past it the portal truncates without an error.
const MESSAGE_MAX = 20_000;

// Classic REST hands ids and statuses back as strings.
const numeric = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number);

// `description` is required, not optional: reading an unexpected shape as "empty" would make
// append overwrite the whole description with the new text.
const descriptionResponse = z.object({ data: z.object({ description: z.string().nullable() }) });
const messageResponse = z.object({ result: numeric });

function parseResponse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, method: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${method} returned an unexpected shape`);
  return parsed.data;
}

async function writeDescription(ctx: OpContext, taskId: number, text: string) {
  await ctx.call({ ...TASK_UPDATE, params: { taskId, fields: { DESCRIPTION: text } } });
  return { taskId, length: text.length };
}

const DESCRIPTION_FORMAT =
  "Формат — BBCode: [b] [i] [u] [s], [url=…]…[/url], [user=ID]Имя[/user], списки [list] / [list=1] " +
  "с пунктами [*], [quote], [code], [spoiler=Заголовок]…[/spoiler], таблицы [table][tr][th]/[td]. " +
  "Вложения [disk file id=…] в описании не трогай — это прикреплённые файлы.";

const CHAT_FORMAT =
  "Формат — только то, что видно и в вебе, и в мобильном: [b] [i] [u] [s], [url=…]…[/url], " +
  "[user=ID]Имя[/user], [code], [color=#hex]…[/color], [br]. Цитата — строка, начинающаяся с «>>», " +
  "или блок между двумя строками из дефисов; список — строки, начинающиеся с «• ». " +
  "В чате НЕ рендерятся: [quote], [list], [spoiler], таблицы и Markdown.";

export const WRITE_OPERATIONS: Operation[] = [
  defineOperation({
    name: "task_description_set",
    description:
      "⚠ МУТИРУЮЩИЙ. ЗАМЕНИТЬ описание задачи целиком (text — новое описание; пустая строка очищает). " +
      "Чтобы ДОПИСАТЬ к существующему — bitrix_task_description_append. Правка видна в истории задачи. " +
      DESCRIPTION_FORMAT,
    mutating: true,
    input: { taskId: idArg(), text: z.string().max(DESCRIPTION_MAX) },
    run: (ctx, a) => writeDescription(ctx, a.taskId, a.text),
  }),
  defineOperation({
    name: "task_description_append",
    description:
      "⚠ МУТИРУЮЩИЙ. ДОПИСАТЬ text в конец описания задачи через пустую строку; всё, что уже есть " +
      "(файлы [disk file id=…], таблицы, списки), остаётся как было. Правка видна в истории задачи. " +
      DESCRIPTION_FORMAT,
    mutating: true,
    input: { taskId: idArg(), text: z.string().min(1).max(DESCRIPTION_MAX) },
    run: async (ctx, a) => {
      const raw = await ctx.call({ ...TASK_V2_GET, params: { task: { id: a.taskId } } });
      const current = (parseResponse(descriptionResponse, raw, "tasks.v2.Task.get (description)").data.description ?? "").trimEnd();
      return writeDescription(ctx, a.taskId, current ? `${current}\n\n${a.text}` : a.text);
    },
  }),
  defineOperation({
    name: "chat_send",
    description:
      "⚠ МУТИРУЮЩИЙ. Отправить сообщение в чат. Адрес — РОВНО ОДНО из: chatId (числовой id чата) или " +
      'dialogId строкой (userId — личный чат с человеком, либо "chat"+chatId). Чат задачи: CHAT_ID из ' +
      'bitrix_task_get (или bitrix_entity_chat с entityType "TASKS_TASK"). Сообщение видят все ' +
      "участники чата; упоминание [user=ID]Имя[/user] шлёт этому человеку уведомление. " +
      `До ${MESSAGE_MAX} символов (длиннее Bitrix молча обрежет). ` +
      CHAT_FORMAT,
    mutating: true,
    input: { chatId: idArg().optional(), dialogId: z.string().min(1).optional(), text: z.string().min(1).max(MESSAGE_MAX) },
    run: async (ctx, a) => {
      const dialogId = a.chatId !== undefined ? `chat${a.chatId}` : a.dialogId;
      if (dialogId === undefined || (a.chatId !== undefined && a.dialogId !== undefined)) {
        throw new OpInputError("invalid arguments for chat_send — pass exactly one of chatId / dialogId");
      }
      const raw = await ctx.call({ ...MESSAGE_ADD, params: { DIALOG_ID: dialogId, MESSAGE: a.text } });
      const messageId = parseResponse(messageResponse, raw, "im.message.add").result;
      return { ...(a.chatId !== undefined ? { chatId: a.chatId } : {}), dialogId, messageId };
    },
  }),
];
