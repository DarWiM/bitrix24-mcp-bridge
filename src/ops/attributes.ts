// Task attributes besides content, people and placement: priority, deadline, and what concerns the
// current user alone — muted notifications and reminders.
// None of them takes agent `params`: merged-in fields could widen a write beyond what the tool
// says it does.

import { z } from "zod";
import { errorMessage, forEachTask, taskIdsArg } from "./batch.js";
import { currentUserId } from "./board.js";
import { numeric, parseResponse } from "./calls.js";
import { TASK_V2_UPDATE, dateArg, fromTs, toTs } from "./content.js";
import { defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { TASK_V2_GET, callTarget } from "./read.js";

const v2 = (action: string) => callTarget({ action, method: "POST", bodyType: "json" });
const DEADLINE_UPDATE = v2("tasks.v2.Task.Deadline.update");
const MUTE = v2("tasks.v2.Task.Attention.mute");
const UNMUTE = v2("tasks.v2.Task.Attention.unmute");
const REMINDER_LIST = v2("tasks.v2.Task.Reminder.list");
const REMINDER_ADD = v2("tasks.v2.Task.Reminder.add");
const REMINDER_UPDATE = v2("tasks.v2.Task.Reminder.update");
const REMINDER_DELETE = v2("tasks.v2.Task.Reminder.delete");

// The only two values the task card was seen to send.
const PRIORITIES = ["high", "average"] as const;
const CHANNELS = ["notification", "email"] as const;

const priorityResponse = z.object({ data: z.object({ priority: z.string() }) });
// Required: a deadline missing from the card must not pass for a cleared one.
const deadlineResponse = z.object({ data: z.object({ deadlineTs: z.number().nullable() }) });
const doneResponse = z.object({ data: z.literal(true) });
const reminderAddResponse = z.object({ data: z.object({ id: numeric }) });
const remindersResponse = z.object({
  data: z.array(
    z.object({
      id: numeric,
      userId: numeric,
      nextRemindTs: z.number().nullable(),
      remindBy: z.string(),
      remindVia: z.string(),
      recipient: z.string(),
    }),
  ),
});

type Reminder = z.infer<typeof remindersResponse>["data"][number];

async function readCard<T>(ctx: OpContext, taskId: number, schema: z.ZodType<T, z.ZodTypeDef, unknown>, what: string) {
  const raw = await ctx.call({ ...TASK_V2_GET, params: { task: { id: taskId } } });
  return parseResponse(schema, raw, `tasks.v2.Task.get (${what})`);
}

async function readReminders(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REMINDER_LIST, params: { taskId } });
  return parseResponse(remindersResponse, raw, "tasks.v2.Task.Reminder.list").data;
}

const reminderView = (r: Reminder) => ({ id: r.id, at: fromTs(r.nextRemindTs), via: r.remindVia, remindBy: r.remindBy, recipient: r.recipient });

// The write went out: a failed re-read must not read as a failed write.
const reread = <T>(read: Promise<T>, checkWith: string) =>
  read.catch((e: unknown) => {
    throw new Error(`запись отправлена, но перечитать не удалось (проверь через ${checkWith}): ${errorMessage(e)}`);
  });

const DATE_FORMAT = 'ISO 8601 со смещением (напр. "2026-11-10T09:00:00+03:00" или "…Z")';
const BATCH_NOTE = "Задачи обрабатываются по очереди; ошибка одной не останавливает остальные.";

export const ATTRIBUTE_OPERATIONS: Operation[] = [
  defineOperation({
    name: "task_priority",
    description:
      "⚠ МУТИРУЮЩИЙ. Задать ВАЖНОСТЬ задач (taskIds — до 50): priority high — важная (отметка «Важная задача»), " +
      "average — обычная. Важность видят все, кто видит задачу; правка видна в истории задачи. После записи " +
      `важность перечитывается; если не сменилась — ok: false. ${BATCH_NOTE} ` +
      "Ответ: { results: [{ taskId, ok, error?, priority }] }.",
    mutating: true,
    budget: "long",
    input: { taskIds: taskIdsArg(), priority: z.enum(PRIORITIES) },
    run: (ctx, a) =>
      forEachTask(a.taskIds, async (taskId) => {
        await ctx.call({ ...TASK_V2_UPDATE, params: { task: { id: taskId, priority: a.priority } } });
        const { priority } = (await reread(readCard(ctx, taskId, priorityResponse, "priority"), "bitrix_task_get_v2")).data;
        if (priority !== a.priority) throw new Error(`Bitrix ответил успехом, но важность не сменилась (сейчас ${priority})`);
        return { priority };
      }),
  }),
  defineOperation({
    name: "task_deadline",
    description:
      `⚠ МУТИРУЮЩИЙ. Задать КРАЙНИЙ СРОК задач (taskIds — до 50): deadline — ${DATE_FORMAT}; null — убрать срок. ` +
      "reason — причина переноса срока, простой текст (необязательно; в портале может быть обязательной). " +
      "Срок видят все, кто видит задачу; правка видна в истории задачи. После записи срок перечитывается; если " +
      `он другой — ok: false. ${BATCH_NOTE} Ответ: { results: [{ taskId, ok, error?, deadline }] } (UTC).`,
    mutating: true,
    budget: "long",
    input: { taskIds: taskIdsArg(), deadline: dateArg().nullable(), reason: z.string().optional() },
    run: (ctx, a) => {
      const deadlineTs = toTs(a.deadline);
      return forEachTask(a.taskIds, async (taskId) => {
        await ctx.call({ ...DEADLINE_UPDATE, params: { task: { id: taskId, deadlineTs, deadlineChangeReason: a.reason ?? "" } } });
        const card = await reread(readCard(ctx, taskId, deadlineResponse, "deadline"), "bitrix_task_get_v2");
        const actual = card.data.deadlineTs ?? 0;
        if (actual !== deadlineTs) throw new Error(`Bitrix ответил успехом, но срок другой: сейчас ${fromTs(actual) ?? "нет"}`);
        return { deadline: fromTs(deadlineTs) };
      });
    },
  }),
  defineOperation({
    name: "task_mute",
    description:
      "⚠ МУТИРУЮЩИЙ. Выключить (muted: true) или включить (muted: false) ТВОИ уведомления по задаче. Касается " +
      "только тебя: другие участники этого не видят и уведомления получают как прежде. Прочитать текущее " +
      "состояние нельзя — ответ { taskId, muted } подтверждает только, что Bitrix принял запрос.",
    mutating: true,
    input: { taskId: idArg(), muted: z.boolean() },
    run: async (ctx, a) => {
      const raw = await ctx.call({ ...(a.muted ? MUTE : UNMUTE), params: { taskId: a.taskId } });
      parseResponse(doneResponse, raw, `tasks.v2.Task.Attention.${a.muted ? "mute" : "unmute"}`);
      return { taskId: a.taskId, muted: a.muted };
    },
  }),
  defineOperation({
    name: "task_reminders",
    description:
      "Напоминания по задаче (read-only): { taskId, reminders: [{ id, at, via, remindBy, recipient }] } — at — " +
      "когда сработает (UTC), via — notification (уведомление в Битрикс24) / email, remindBy — date (на дату) / " +
      "deadline (относительно срока), recipient — кому (myself — тебе). id — для bitrix_task_reminder_set / " +
      "bitrix_task_reminder_delete.",
    mutating: false,
    input: { taskId: idArg() },
    run: async (ctx, a) => ({ taskId: a.taskId, reminders: (await readReminders(ctx, a.taskId)).map(reminderView) }),
  }),
  defineOperation({
    name: "task_reminder_set",
    description:
      `⚠ МУТИРУЮЩИЙ. Поставить НАПОМИНАНИЕ по задаче на дату at — ${DATE_FORMAT}; via — notification ` +
      "(уведомление в Битрикс24) или email. Без reminderId создаётся новое напоминание тебе; его получаешь только " +
      "ты, другие участники его не видят. С reminderId (из bitrix_task_reminders) меняется существующее: дата и " +
      "канал, получатель остаётся прежним; напоминание относительно срока становится напоминанием на дату. После " +
      "записи напоминание перечитывается; если оно другое — ошибка. Ответ: { taskId, reminder: { id, at, via, " +
      "remindBy, recipient } } (at — UTC).",
    mutating: true,
    // Three requests in a row.
    budget: "long",
    input: { taskId: idArg(), reminderId: idArg().optional(), at: dateArg(), via: z.enum(CHANNELS) },
    run: async (ctx, a) => {
      const { taskId } = a;
      const nextRemindTs = toTs(a.at);
      let id: number;
      if (a.reminderId === undefined) {
        const userId = await currentUserId(ctx);
        // The id the task card makes up for a reminder not saved yet; Bitrix answers with the real one.
        const draft = { id: `tmp${Date.now()}`, taskId, userId, nextRemindTs, remindBy: "date", remindVia: a.via, recipient: "myself", before: 0 };
        const parsed = reminderAddResponse.safeParse(await ctx.call({ ...REMINDER_ADD, params: { reminder: draft } }));
        if (!parsed.success) {
          throw new Error(
            "tasks.v2.Task.Reminder.add returned an unexpected shape — напоминание могло создаться, проверь bitrix_task_reminders перед повтором",
          );
        }
        id = parsed.data.data.id;
      } else {
        const current = (await readReminders(ctx, taskId)).find((r) => r.id === a.reminderId);
        if (!current) {
          throw new Error(`у задачи ${taskId} нет напоминания ${a.reminderId} — ничего не изменено; список — bitrix_task_reminders`);
        }
        // The update replaces the whole reminder: whose it is and whom it reaches are written back as they are.
        const reminder = {
          id: current.id,
          taskId,
          userId: current.userId,
          nextRemindTs,
          remindBy: "date",
          remindVia: a.via,
          recipient: current.recipient,
          before: 0,
        };
        await ctx.call({ ...REMINDER_UPDATE, params: { reminder } });
        id = current.id;
      }
      const saved = (await reread(readReminders(ctx, taskId), "bitrix_task_reminders")).find((r) => r.id === id);
      if (!saved) throw new Error(`Bitrix ответил успехом, но напоминания ${id} нет у задачи ${taskId}`);
      if (saved.nextRemindTs !== nextRemindTs || saved.remindVia !== a.via) {
        throw new Error(`Bitrix ответил успехом, но напоминание ${id} другое: ${fromTs(saved.nextRemindTs) ?? "без даты"}, ${saved.remindVia}`);
      }
      return { taskId, reminder: reminderView(saved) };
    },
  }),
  defineOperation({
    name: "task_reminder_delete",
    description:
      "⚠ МУТИРУЮЩИЙ. Удалить напоминание по id (из bitrix_task_reminders). Другие участники об этом не узнают. " +
      "Удаление не перечитывается — проверить можно через bitrix_task_reminders. Ответ: { reminderId, deleted: true }.",
    mutating: true,
    input: { reminderId: idArg() },
    run: async (ctx, a) => {
      const raw = await ctx.call({ ...REMINDER_DELETE, params: { reminder: { id: a.reminderId } } });
      parseResponse(doneResponse, raw, "tasks.v2.Task.Reminder.delete");
      return { reminderId: a.reminderId, deleted: true };
    },
  }),
];
