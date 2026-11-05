// Operations that post to chats or change a posted message.
// None of them takes agent `params`: merged-in fields could widen a write beyond what the tool
// says it does.

import { z } from "zod";
import { errorMessage, forEachTask, taskIdsArg } from "./batch.js";
import { REST_TASK_GET, numeric, parseResponse, restMethod } from "./calls.js";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { callTarget } from "./read.js";

const MESSAGE_ADD = restMethod("im.message.add");
const MESSAGE_UPDATE = restMethod("im.message.update");
// What the web chat sends; the session has no REST method for reactions.
const REACTION_ADD = callTarget({ action: "im.v2.Chat.Message.Reaction.add", method: "POST" });

// Bitrix's documented message limit; past it the portal truncates without an error.
const MESSAGE_MAX = 20_000;

const messageResponse = z.object({ result: numeric });
const updateResponse = z.object({ result: z.boolean() });
const reactionResponse = z.object({ data: z.object({ result: z.boolean() }) });
// The key is required: an unexpected shape must not read as "no chat". "0" means none, as null does.
const taskChatResponse = z.object({
  result: z.object({ task: z.object({ chatId: numeric.nullable().transform((id) => id || null) }) }),
});

const CHAT_FORMAT =
  "Формат — только то, что видно и в вебе, и в мобильном: [b] [i] [u] [s], [url=…]…[/url], " +
  "[user=ID]Имя[/user], [code], [color=#hex]…[/color], [br]. Цитата — строка, начинающаяся с «>>», " +
  "или блок между двумя строками из дефисов; список — строки, начинающиеся с «• ». " +
  "В чате НЕ рендерятся: [quote], [list], [spoiler], таблицы и Markdown.";

const SEND_MAY_HAVE_GONE = "сообщение могло уйти, проверь чат (bitrix_chat_messages) перед повтором";

const KNOWN_REACTIONS = ["like", "whiteHeavyCheckMark"];

const messageText = () => z.string().min(1).max(MESSAGE_MAX);

async function postMessage(ctx: OpContext, dialogId: string, text: string, replyTo?: number) {
  const params = { DIALOG_ID: dialogId, MESSAGE: text, ...(replyTo !== undefined ? { REPLY_ID: replyTo } : {}) };
  // A timeout or a lost extension does not mean the portal did not post it: a blind retry would
  // post it twice.
  const raw = await ctx.call({ ...MESSAGE_ADD, params }).catch((e: unknown) => {
    throw new Error(`${errorMessage(e)} — ${SEND_MAY_HAVE_GONE}`);
  });
  return parseResponse(messageResponse, raw, "im.message.add").result;
}

async function readTaskChat(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REST_TASK_GET, params: { taskId, select: ["ID", "CHAT_ID"] } });
  return parseResponse(taskChatResponse, raw, "tasks.task.get").result.task.chatId;
}

export const CHAT_OPERATIONS: Operation[] = [
  defineOperation({
    name: "chat_send",
    description:
      "⚠ МУТИРУЮЩИЙ. Отправить сообщение в чат. Адрес — РОВНО ОДНО из: chatId (числовой id чата) или " +
      'dialogId строкой (userId — личный чат с человеком, либо "chat"+chatId). Чат задачи: CHAT_ID из ' +
      'bitrix_task_get (или bitrix_entity_chat с entityType "TASKS_TASK"); в чаты задач проще писать через ' +
      "bitrix_task_chat_post. replyTo — id сообщения этого чата, на которое это ответ (в чате покажется ответом " +
      "на него). Сообщение видят все участники чата; упоминание [user=ID]Имя[/user] шлёт этому человеку " +
      `уведомление. До ${MESSAGE_MAX} символов (длиннее Bitrix молча обрежет). ` +
      CHAT_FORMAT,
    mutating: true,
    input: {
      chatId: idArg().optional(),
      dialogId: z.string().min(1).optional(),
      text: messageText(),
      replyTo: idArg().optional(),
    },
    run: async (ctx, a) => {
      const dialogId = a.chatId !== undefined ? `chat${a.chatId}` : a.dialogId;
      if (dialogId === undefined || (a.chatId !== undefined && a.dialogId !== undefined)) {
        throw new OpInputError("invalid arguments for chat_send — pass exactly one of chatId / dialogId");
      }
      const messageId = await postMessage(ctx, dialogId, a.text, a.replyTo);
      return { ...(a.chatId !== undefined ? { chatId: a.chatId } : {}), dialogId, messageId };
    },
  }),
  defineOperation({
    name: "chat_message_edit",
    description:
      "⚠ МУТИРУЮЩИЙ. Заменить текст сообщения в чате целиком (messageId — id сообщения, text — новый текст). " +
      "Редактировать можно только СВОИ сообщения — чужое Bitrix не даст изменить (ошибка). Правку видят все " +
      "участники чата; уведомит ли новое упоминание [user=ID] — не проверено, чтобы точно уведомить, отправь " +
      `новое сообщение (bitrix_chat_send). До ${MESSAGE_MAX} символов. ` +
      CHAT_FORMAT,
    mutating: true,
    input: {
      messageId: idArg(),
      // Bitrix deletes a message updated to an empty text.
      text: messageText().refine((t) => t.trim().length > 0, "text must not be blank"),
    },
    run: async (ctx, a) => {
      const raw = await ctx.call({ ...MESSAGE_UPDATE, params: { MESSAGE_ID: a.messageId, MESSAGE: a.text } });
      if (!parseResponse(updateResponse, raw, "im.message.update").result) {
        throw new Error(`Bitrix не изменил сообщение ${a.messageId} (редактировать можно только свои сообщения)`);
      }
      return { messageId: a.messageId };
    },
  }),
  defineOperation({
    name: "chat_reaction",
    description:
      "⚠ МУТИРУЮЩИЙ. Поставить реакцию на сообщение в чате от твоего имени (messageId — id сообщения). " +
      `reaction — имя реакции латиницей; проверены ${KNOWN_REACTIONS.join(", ")} (👍 и ✅). Другие имена ` +
      "передаются в Bitrix как есть, без проверки: неизвестное имя может дать ошибку или реакцию, которую " +
      "чат не покажет. Реакцию видят все участники чата; уведомляется ли автор сообщения — не проверено.",
    mutating: true,
    input: { messageId: idArg(), reaction: z.string().regex(/^[A-Za-z]+$/).max(64) },
    run: async (ctx, a) => {
      const raw = await ctx.call({ ...REACTION_ADD, params: { messageId: a.messageId, reaction: a.reaction } });
      if (!parseResponse(reactionResponse, raw, "im.v2.Chat.Message.Reaction.add").data.result) {
        throw new Error(`Bitrix не поставил реакцию ${a.reaction} на сообщение ${a.messageId}`);
      }
      return { messageId: a.messageId, reaction: a.reaction };
    },
  }),
  defineOperation({
    name: "task_chat_post",
    description:
      "⚠ МУТИРУЮЩИЙ. Написать одно и то же сообщение в ЧАТЫ задач (taskIds — до 50) от твоего имени: чат " +
      "каждой задачи находится по её CHAT_ID. Сообщение видят все участники чата задачи; упоминание " +
      "[user=ID]Имя[/user] шлёт этому человеку уведомление. У задачи без чата — ошибка этой задачи. " +
      `До ${MESSAGE_MAX} символов (длиннее Bitrix молча обрежет). ` +
      CHAT_FORMAT +
      " Задачи обрабатываются по очереди; ошибка одной не останавливает остальные. " +
      "Ответ: { results: [{ taskId, ok, error?, chatId, messageId }] }.",
    mutating: true,
    // Two requests per task.
    budget: "long",
    input: { taskIds: taskIdsArg(), text: messageText() },
    run: (ctx, a) =>
      forEachTask(a.taskIds, async (taskId) => {
        const chatId = await readTaskChat(ctx, taskId);
        if (chatId === null) throw new Error(`у задачи ${taskId} нет чата`);
        return { chatId, messageId: await postMessage(ctx, `chat${chatId}`, a.text) };
      }),
  }),
];
