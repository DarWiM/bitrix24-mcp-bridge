// Task attributes besides content, people and placement: priority, deadline, and what concerns the
// current user alone — muted notifications and reminders.
// None of them takes agent `params`: merged-in fields could widen a write beyond what the tool
// says it does.

import { z } from "zod";
import { forEachTask, taskIdsArg } from "./batch.js";
import { currentUserId } from "./board.js";
import { mayHaveHappened, numeric, parseResponse, parseTaskCard, reread, v2 } from "./calls.js";
import { TASK_V2_UPDATE, dateArg, fromTs, sameMinute, toTs } from "./content.js";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { TASK_V2_GET } from "./read.js";

const DEADLINE_UPDATE = v2("tasks.v2.Task.Deadline.update");
const MUTE = v2("tasks.v2.Task.Attention.mute");
const UNMUTE = v2("tasks.v2.Task.Attention.unmute");
const REMINDER_LIST = v2("tasks.v2.Task.Reminder.list");
const REMINDER_ADD = v2("tasks.v2.Task.Reminder.add");
const REMINDER_UPDATE = v2("tasks.v2.Task.Reminder.update");
const REMINDER_DELETE = v2("tasks.v2.Task.Reminder.delete");

// The only two values the task card was seen to send.
const PRIORITIES = ["high", "average"] as const;
const REASON_MAX = 1000;
const CHANNELS = ["notification", "email"] as const;

const priorityResponse = z.object({ data: z.object({ priority: z.string() }) });
// Required: a deadline missing from the card must not pass for a cleared one.
const deadlineResponse = z.object({ data: z.object({ deadlineTs: numeric.nullable() }) });
// Who of the participants muted the task; required, so that an unexpected card is not read as "nobody".
const muteResponse = z.object({ data: z.object({ inMute: z.array(numeric) }) });
const reminderAddResponse = z.object({ data: z.object({ id: numeric }) });
const remindersResponse = z.object({
  data: z.array(
    z.object({
      id: numeric,
      userId: numeric,
      nextRemindTs: numeric.nullable(),
      remindBy: z.string(),
      remindVia: z.string(),
      recipient: z.string(),
    }),
  ),
});

type Reminder = z.infer<typeof remindersResponse>["data"][number];

async function readCard<T>(ctx: OpContext, taskId: number, schema: z.ZodType<T, z.ZodTypeDef, unknown>, what: string) {
  const raw = await ctx.call({ ...TASK_V2_GET, params: { task: { id: taskId } } });
  return parseTaskCard(schema, raw, `tasks.v2.Task.get (${what})`, taskId);
}

async function readReminders(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REMINDER_LIST, params: { taskId } });
  return parseResponse(remindersResponse, raw, "tasks.v2.Task.Reminder.list").data;
}

// Another user's reminder is theirs to change: the agent acts for the current user only.
async function ownReminder(ctx: OpContext, taskId: number, reminderId: number, nothingDone: string) {
  const userId = await currentUserId(ctx);
  const found = (await readReminders(ctx, taskId)).find((r) => r.id === reminderId);
  if (!found) throw new Error(`у задачи ${taskId} нет напоминания ${reminderId} — ${nothingDone}; список — bitrix_task_reminders`);
  if (found.userId !== userId) {
    throw new Error(`напоминание ${reminderId} — пользователя ${found.userId}, а менять можно только свои — ${nothingDone}`);
  }
  return found;
}

const reminderView = (r: Reminder) => ({ id: r.id, at: fromTs(r.nextRemindTs), via: r.remindVia, remindBy: r.remindBy, recipient: r.recipient });

const DATE_FORMAT = 'ISO 8601 со смещением (напр. "2026-11-10T09:00:00+03:00" или "…Z")';
const REMINDER_MAY_EXIST = "напоминание могло создаться — проверь bitrix_task_reminders перед повтором";
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
      `reason — причина переноса срока, простой текст до ${REASON_MAX} символов (необязательно; в портале может быть обязательной). ` +
      "Срок видят все, кто видит задачу; правка видна в истории задачи. После записи срок перечитывается; если " +
      `он другой — ok: false. ${BATCH_NOTE} Ответ: { results: [{ taskId, ok, error?, deadline }] } (UTC).`,
    mutating: true,
    budget: "long",
    input: { taskIds: taskIdsArg(), deadline: dateArg().nullable(), reason: z.string().max(REASON_MAX).optional() },
    run: (ctx, a) => {
      const deadlineTs = toTs(a.deadline);
      return forEachTask(a.taskIds, async (taskId) => {
        await ctx.call({ ...DEADLINE_UPDATE, params: { task: { id: taskId, deadlineTs, deadlineChangeReason: a.reason ?? "" } } });
        const card = await reread(readCard(ctx, taskId, deadlineResponse, "deadline"), "bitrix_task_get_v2");
        const actual = card.data.deadlineTs ?? 0;
        if (!sameMinute(actual, deadlineTs)) throw new Error(`Bitrix ответил успехом, но срок другой: сейчас ${fromTs(actual) ?? "нет"}`);
        return { deadline: fromTs(actual) };
      });
    },
  }),
  defineOperation({
    name: "task_mute",
    description:
      "⚠ МУТИРУЮЩИЙ. Выключить (muted: true) или включить (muted: false) ТВОИ уведомления по задаче. Касается " +
      "только тебя: другие участники этого не видят и уведомления получают как прежде. После записи состояние " +
      "перечитывается; если оно не то — ошибка. Ответ: { taskId, muted }.",
    mutating: true,
    // Three requests in a row.
    budget: "long",
    input: { taskId: idArg(), muted: z.boolean() },
    run: async (ctx, a) => {
      const { taskId } = a;
      // Asked before the write, so that the only request after it is the re-read.
      const userId = await currentUserId(ctx);
      await ctx.call({ ...(a.muted ? MUTE : UNMUTE), params: { taskId } });
      const { inMute } = (await reread(readCard(ctx, taskId, muteResponse, "mute"), "bitrix_task_get_v2")).data;
      const muted = inMute.includes(userId);
      if (muted !== a.muted) {
        throw new Error(`Bitrix ответил успехом, но уведомления по задаче ${muted ? "по-прежнему выключены" : "по-прежнему включены"}`);
      }
      return { taskId, muted };
    },
  }),
  defineOperation({
    name: "task_reminders",
    description:
      "Напоминания по задаче (read-only): { taskId, reminders: [{ id, at, via, remindBy, recipient, userId, mine }] } — " +
      "at — когда сработает (UTC), via — notification (уведомление в Битрикс24) / email, remindBy — date (на дату) / " +
      "deadline (относительно срока), recipient — кому (myself — владельцу), userId — чьё напоминание, mine — твоё ли. " +
      "id — для bitrix_task_reminder_set / bitrix_task_reminder_delete; они работают только с напоминаниями mine: true.",
    mutating: false,
    // Two requests in a row.
    budget: "long",
    input: { taskId: idArg() },
    run: async (ctx, a) => {
      const userId = await currentUserId(ctx);
      const reminders = (await readReminders(ctx, a.taskId)).map((r) => ({ ...reminderView(r), userId: r.userId, mine: r.userId === userId }));
      return { taskId: a.taskId, reminders };
    },
  }),
  defineOperation({
    name: "task_reminder_set",
    description:
      `⚠ МУТИРУЮЩИЙ. Поставить НАПОМИНАНИЕ по задаче на дату at — ${DATE_FORMAT}; via — notification ` +
      "(уведомление в Битрикс24) или email. Без reminderId создаётся новое напоминание тебе; его получаешь только " +
      "ты, другие участники его не видят. at — в будущем. С reminderId (из bitrix_task_reminders) меняется " +
      "существующее — только свои напоминания: дата и канал, получатель остаётся прежним; напоминание относительно " +
      "срока становится напоминанием на дату. После записи напоминание перечитывается; если оно другое — ошибка. " +
      "Ответ: { taskId, reminder: { id, at, via, " +
      "remindBy, recipient } } (at — UTC).",
    mutating: true,
    // Up to four requests in a row.
    budget: "long",
    input: { taskId: idArg(), reminderId: idArg().optional(), at: dateArg(), via: z.enum(CHANNELS) },
    run: async (ctx, a) => {
      const { taskId } = a;
      const nextRemindTs = toTs(a.at);
      if (nextRemindTs <= Date.now() / 1000) throw new OpInputError("invalid arguments for task_reminder_set — at is in the past");
      let id: number;
      let recipient: string;
      if (a.reminderId === undefined) {
        const userId = await currentUserId(ctx);
        // The id the task card makes up for a reminder not saved yet; Bitrix answers with the real one.
        const draft = { id: `tmp${Date.now()}`, taskId, userId, nextRemindTs, remindBy: "date", remindVia: a.via, recipient: "myself", before: 0 };
        const write = ctx.call({ ...REMINDER_ADD, params: { reminder: draft } });
        id = (await mayHaveHappened(write, reminderAddResponse, "tasks.v2.Task.Reminder.add", REMINDER_MAY_EXIST)).data.id;
        recipient = draft.recipient;
      } else {
        const current = await ownReminder(ctx, taskId, a.reminderId, "ничего не изменено");
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
        recipient = current.recipient;
      }
      const saved = (await reread(readReminders(ctx, taskId), "bitrix_task_reminders")).find((r) => r.id === id);
      if (!saved) throw new Error(`Bitrix ответил успехом, но напоминания ${id} нет у задачи ${taskId}`);
      if (!sameMinute(saved.nextRemindTs, nextRemindTs) || saved.remindVia !== a.via || saved.remindBy !== "date" || saved.recipient !== recipient) {
        const now = [fromTs(saved.nextRemindTs) ?? "без даты", saved.remindVia, saved.remindBy, saved.recipient].join(", ");
        throw new Error(`Bitrix ответил успехом, но напоминание ${id} другое: ${now}`);
      }
      return { taskId, reminder: reminderView(saved) };
    },
  }),
  defineOperation({
    name: "task_reminder_delete",
    description:
      "⚠ МУТИРУЮЩИЙ. Удалить напоминание reminderId задачи taskId (id — из bitrix_task_reminders) — только свои " +
      "напоминания. Другие участники об этом не узнают. Нет такого напоминания у задачи или оно чужое — ошибка, " +
      "ничего не удаляется. После удаления " +
      "список перечитывается; если напоминание осталось — ошибка. Ответ: { taskId, reminderId, deleted: true }.",
    mutating: true,
    // Four requests in a row.
    budget: "long",
    input: { taskId: idArg(), reminderId: idArg() },
    run: async (ctx, a) => {
      const { taskId, reminderId } = a;
      // Reminder ids are portal-wide: without this check a wrong taskId would delete another task's reminder.
      await ownReminder(ctx, taskId, reminderId, "ничего не удалено");
      await ctx.call({ ...REMINDER_DELETE, params: { reminder: { id: reminderId } } });
      const left = await reread(readReminders(ctx, taskId), "bitrix_task_reminders");
      if (left.some((r) => r.id === reminderId)) throw new Error(`Bitrix ответил успехом, но напоминание ${reminderId} осталось`);
      return { taskId, reminderId, deleted: true };
    },
  }),
];
