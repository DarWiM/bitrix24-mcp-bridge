// Operations that edit what a task holds besides people and placement: a fragment of the
// description, tags, checklist items, plan dates.
// None of them takes agent `params`: merged-in fields could widen a write beyond what the tool
// says it does.

import { z } from "zod";
import { MAX_BATCH, errorMessage, forEachTask, taskIdsArg } from "./batch.js";
import { numeric, parseResponse, restMethod } from "./calls.js";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { TASK_V2_GET, callTarget } from "./read.js";
import { DESCRIPTION_FORMAT, DESCRIPTION_MAX, readDescription, writeDescription } from "./write.js";

// The classic TAGS field cannot be cleared through a form body; the v2 update replaces the list.
export const TASK_V2_UPDATE = callTarget({ action: "tasks.v2.Task.update", method: "POST", bodyType: "json" });
const PLAN_UPDATE = callTarget({ action: "tasks.v2.Task.Plan.update", method: "POST", bodyType: "json" });
const CHECKLIST_LIST = restMethod("task.checklistitem.getlist");
const CHECKLIST_ADD = restMethod("task.checklistitem.add");
const CHECKLIST_UPDATE = restMethod("task.checklistitem.update");
const CHECKLIST_COMPLETE = restMethod("task.checklistitem.complete");
const CHECKLIST_RENEW = restMethod("task.checklistitem.renew");
const CHECKLIST_DELETE = restMethod("task.checklistitem.delete");

// `tags` is required: an unexpected shape read as "no tags" would make add drop all the others.
const tagsResponse = z.object({ data: z.object({ tags: z.array(z.object({ name: z.string() })) }) });
const checklistResponse = z.object({
  result: z.array(z.object({ ID: numeric, PARENT_ID: numeric, TITLE: z.string(), IS_COMPLETE: z.enum(["Y", "N"]) })),
});
const checklistAddResponse = z.object({ result: numeric });
const checklistDoneResponse = z.object({ result: z.literal(true) });
// Both required: a date read as "none" would be written back as a cleared one.
const planResponse = z.object({ data: z.object({ startPlanTs: z.number().nullable(), endPlanTs: z.number().nullable() }) });

const tagKey = (name: string) => name.trim().toLowerCase();

// The request went through but its answer did not say what happened.
class SentUnconfirmed extends Error {}

async function readTags(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...TASK_V2_GET, params: { task: { id: taskId } } });
  return parseResponse(tagsResponse, raw, "tasks.v2.Task.get (tags)").data.tags.map((t) => t.name);
}

async function readPlan(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...TASK_V2_GET, params: { task: { id: taskId } } });
  const { startPlanTs, endPlanTs } = parseResponse(planResponse, raw, "tasks.v2.Task.get (plan dates)").data;
  return { startPlanTs: startPlanTs ?? 0, endPlanTs: endPlanTs ?? 0 };
}

async function readChecklist(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...CHECKLIST_LIST, params: { TASKID: taskId } });
  return parseResponse(checklistResponse, raw, "task.checklistitem.getlist").result.map((item) => ({
    id: item.ID,
    parentId: item.PARENT_ID,
    title: item.TITLE,
    done: item.IS_COMPLETE === "Y",
  }));
}

const tagNamesArg = () => z.array(z.string().trim().min(1)).max(MAX_BATCH).optional();
const itemIdsArg = () => z.array(idArg()).max(MAX_BATCH).optional();
const checklistTitle = () => z.string().trim().min(1);
// An offset is required: without one the date would be read in the daemon's time zone.
// Unix time 0 means "no date" to Bitrix, so nothing at or before the epoch can be written.
export const dateArg = () =>
  z
    .string()
    .datetime({ offset: true })
    .refine((date) => Date.parse(date) >= 1000, "date must be after 1970-01-01T00:00:00Z");
const planDateArg = () => dateArg().nullable().optional();

export const toTs = (date: string | null) => (date === null ? 0 : Math.floor(Date.parse(date) / 1000));
export const fromTs = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString() : null);

export const CONTENT_OPERATIONS: Operation[] = [
  defineOperation({
    name: "task_description_replace",
    description:
      "⚠ МУТИРУЮЩИЙ. Точечная правка описания задачи: заменить фрагмент find на replace (пустой replace — " +
      "удалить фрагмент). Совпадение — точная подстрока сырого BBCode (как в bitrix_task_get_v2 → description), " +
      "с учётом регистра и переводов строк. Нет совпадений — ошибка; несколько (считая и перекрывающиеся, " +
      'как "aa" в "aaa") — ошибка с их числом, если не передан all: true. all заменяет все НЕперекрывающиеся ' +
      'вхождения слева направо ("aaa", find "aa" → одна замена). Всё вне фрагмента остаётся как было. Правка ' +
      "видна в истории задачи. Ответ: { taskId, replaced, length } — replaced — сколько замен сделано. " +
      DESCRIPTION_FORMAT,
    mutating: true,
    input: {
      taskId: idArg(),
      find: z.string().min(1).max(DESCRIPTION_MAX),
      replace: z.string().max(DESCRIPTION_MAX),
      all: z.boolean().optional(),
    },
    run: async (ctx, a) => {
      const current = await readDescription(ctx, a.taskId);
      // Overlapping matches count too: in "aaa" the fragment "aa" is ambiguous, not unique.
      let matches = 0;
      for (let i = current.indexOf(a.find); i !== -1; i = current.indexOf(a.find, i + 1)) matches++;
      if (matches === 0) throw new Error("фрагмент find не найден в описании — сверь точный текст через bitrix_task_get_v2");
      if (matches > 1 && !a.all) {
        throw new Error(`фрагмент find встречается в описании ${matches} раз — уточни его или передай all: true`);
      }
      // split/join, not String.replace: `$&` or `$1` in the agent's text must stay literal.
      const parts = current.split(a.find);
      const replaced = parts.length - 1;
      const next = parts.join(a.replace);
      if (next.length > DESCRIPTION_MAX) throw new Error(`после замены описание длиннее ${DESCRIPTION_MAX} символов — ничего не записано`);
      const { length } = await writeDescription(ctx, a.taskId, next);
      return { taskId: a.taskId, replaced, length };
    },
  }),
  defineOperation({
    name: "task_tags",
    description:
      "⚠ МУТИРУЮЩИЙ. Добавить / убрать ТЕГИ задач (taskIds — до 50). add / remove — массивы названий тегов " +
      "(простой текст); нужен хотя бы один непустой; сравнение без учёта регистра. Теги каждой задачи " +
      "читаются заново, список записывается целиком и перечитывается; если менять нечего, запись не делается " +
      "(changed: false). Теги видят все, кто видит задачу; правка видна в истории задачи. Задачи обрабатываются " +
      "по очереди; ошибка одной не останавливает остальные. " +
      "Ответ: { results: [{ taskId, ok, error?, tags, changed }] } — tags — список, перечитанный после записи.",
    mutating: true,
    budget: "long",
    input: { taskIds: taskIdsArg(), add: tagNamesArg(), remove: tagNamesArg() },
    run: async (ctx, a) => {
      const add = a.add ?? [];
      const remove = new Set((a.remove ?? []).map(tagKey));
      if (add.length === 0 && remove.size === 0) {
        throw new OpInputError("invalid arguments for task_tags — pass a non-empty add or remove");
      }
      const both = add.find((name) => remove.has(tagKey(name)));
      if (both !== undefined) throw new OpInputError(`invalid arguments for task_tags — tag "${both}" is in both add and remove`);
      return forEachTask(a.taskIds, async (taskId) => {
        const current = await readTags(ctx, taskId);
        const next = current.filter((name) => !remove.has(tagKey(name)));
        for (const name of add) if (!next.some((n) => tagKey(n) === tagKey(name))) next.push(name);
        const changed = next.length !== current.length || next.some((name, i) => name !== current[i]);
        if (!changed) return { tags: current, changed };
        await ctx.call({ ...TASK_V2_UPDATE, params: { task: { id: taskId, tags: next.map((name) => ({ name })) } } });
        const actual = await readTags(ctx, taskId).catch((e: unknown) => {
          throw new Error(`запись отправлена, но перечитать теги не удалось (проверь через bitrix_task_get_v2): ${errorMessage(e)}`);
        });
        const actualKeys = new Set(actual.map(tagKey));
        const nextKeys = new Set(next.map(tagKey));
        const notAdded = next.filter((name) => !actualKeys.has(tagKey(name)));
        const notRemoved = actual.filter((name) => !nextKeys.has(tagKey(name)));
        if (notAdded.length > 0 || notRemoved.length > 0) {
          const parts = [
            ...(notAdded.length > 0 ? [`добавить ${notAdded.join(", ")}`] : []),
            ...(notRemoved.length > 0 ? [`убрать ${notRemoved.join(", ")}`] : []),
          ];
          throw new Error(`Bitrix не применил: ${parts.join("; ")} (сейчас теги: ${actual.join(", ") || "нет"})`);
        }
        return { tags: actual, changed };
      });
    },
  }),
  defineOperation({
    name: "task_checklist",
    description:
      "Чек-лист задачи (read-only), плоским списком: { taskId, items: [{ id, parentId, title, done }] }. " +
      "Пункты с parentId 0 — группы (первая создаётся автоматически, «BX_CHECKLIST_1»), остальные — пункты " +
      "внутри группы parentId. id — для bitrix_task_checklist_edit.",
    mutating: false,
    input: { taskId: idArg() },
    run: async (ctx, a) => ({ taskId: a.taskId, items: await readChecklist(ctx, a.taskId) }),
  }),
  defineOperation({
    name: "task_checklist_edit",
    description:
      "⚠ МУТИРУЮЩИЙ. Изменить чек-лист задачи: add — новые пункты (названия; при пустом чек-листе Bitrix " +
      "сам создаёт группу), rename — [{ itemId, title }], complete — отметить выполненными, reopen — снять " +
      "отметку, remove — удалить. itemId — из bitrix_task_checklist. Пункт можно за раз переименовать и " +
      "отметить, но нельзя complete и reopen вместе или remove вместе с другой его правкой. Названия — простой " +
      "текст (как в пункте рендерится BBCode, не проверено). Изменения видят все, кто видит задачу. Сначала все " +
      "itemId сверяются с чек-листом (нет пункта — ничего не меняется), затем действия выполняются по " +
      "очереди: add, rename, complete, reopen, remove — всего до 50 действий за вызов; при сбое посередине " +
      "ошибка перечисляет сделанное. Пункты удаляемой группы отдельно не удаляются; если Bitrix их оставит, " +
      "это будет в ошибке. " +
      "Ответ: { taskId, added, items } — added — id новых пунктов, items — чек-лист, перечитанный после правки.",
    mutating: true,
    // One request per item, two more around them.
    budget: "long",
    input: {
      taskId: idArg(),
      add: z.array(checklistTitle()).max(MAX_BATCH).optional(),
      rename: z.array(z.object({ itemId: idArg(), title: checklistTitle() })).max(MAX_BATCH).optional(),
      complete: itemIdsArg(),
      reopen: itemIdsArg(),
      remove: itemIdsArg(),
    },
    run: async (ctx, a) => {
      const TASKID = a.taskId;
      const add = a.add ?? [];
      const rename = a.rename ?? [];
      const complete = a.complete ?? [];
      const reopen = a.reopen ?? [];
      const remove = a.remove ?? [];
      const renamed = rename.map((r) => r.itemId);
      const touched = [...new Set([...renamed, ...complete, ...reopen, ...remove])];
      if (add.length === 0 && touched.length === 0) {
        throw new OpInputError("invalid arguments for task_checklist_edit — pass a non-empty add, rename, complete, reopen or remove");
      }
      const invalid = (message: string) => new OpInputError(`invalid arguments for task_checklist_edit — ${message}`);
      // One request per step: past this the call could outlive the client's wait, and the agent would
      // never see which steps were done.
      const steps = add.length + rename.length + complete.length + reopen.length + remove.length;
      if (steps > MAX_BATCH) throw invalid(`${steps} actions in one call, at most ${MAX_BATCH}`);
      for (const ids of [renamed, complete, reopen, remove]) {
        const twice = ids.find((id, i) => ids.indexOf(id) !== i);
        if (twice !== undefined) throw invalid(`item ${twice} is listed twice in one action`);
      }
      const both = complete.find((id) => reopen.includes(id));
      if (both !== undefined) throw invalid(`item ${both} is in both complete and reopen`);
      const removedAndEdited = remove.find((id) => renamed.includes(id) || complete.includes(id) || reopen.includes(id));
      if (removedAndEdited !== undefined) throw invalid(`item ${removedAndEdited} is removed and edited at once`);

      const before = await readChecklist(ctx, TASKID);
      const missing = touched.filter((id) => !before.some((item) => item.id === id));
      if (missing.length > 0) {
        throw new Error(`в чек-листе задачи ${TASKID} нет пунктов ${missing.join(", ")} — ничего не изменено; список — bitrix_task_checklist`);
      }

      const done: string[] = [];
      const step = async (label: string, request: () => Promise<void>) => {
        try {
          await request();
        } catch (e) {
          const outcome = e instanceof SentUnconfirmed ? "отправлено, ответ не распознан" : `не выполнено (${errorMessage(e)})`;
          throw new Error(
            `${label}: ${outcome}; до этого сделано: ${done.join(", ") || "ничего"} — перечитай чек-лист (bitrix_task_checklist) перед повтором`,
          );
        }
        done.push(label);
      };
      const mark = (target: typeof CHECKLIST_COMPLETE, ITEMID: number, method: string) => async () => {
        parseResponse(checklistDoneResponse, await ctx.call({ ...target, params: { TASKID, ITEMID } }), method);
      };

      const added: number[] = [];
      for (const TITLE of add) {
        await step(`добавить «${TITLE}»`, async () => {
          const raw = await ctx.call({ ...CHECKLIST_ADD, params: { TASKID, FIELDS: { TITLE } } });
          const parsed = checklistAddResponse.safeParse(raw);
          if (!parsed.success) throw new SentUnconfirmed();
          added.push(parsed.data.result);
        });
      }
      for (const { itemId, title } of rename) {
        // Answers null on success.
        await step(`переименовать ${itemId}`, async () => {
          await ctx.call({ ...CHECKLIST_UPDATE, params: { TASKID, ITEMID: itemId, FIELDS: { TITLE: title } } });
        });
      }
      for (const id of complete) await step(`отметить ${id}`, mark(CHECKLIST_COMPLETE, id, "task.checklistitem.complete"));
      for (const id of reopen) await step(`снять отметку ${id}`, mark(CHECKLIST_RENEW, id, "task.checklistitem.renew"));
      // Removing a group takes its items with it: they are not deleted again, nor reported as not applied.
      const gone = new Set<number>();
      const drop = (id: number) => {
        if (gone.has(id)) return;
        gone.add(id);
        for (const item of before) if (item.parentId === id) drop(item.id);
      };
      for (const id of remove) {
        if (gone.has(id)) continue;
        await step(`удалить ${id}`, mark(CHECKLIST_DELETE, id, "task.checklistitem.delete"));
        drop(id);
      }
      // Where a new item lands is Bitrix's choice, so a removed group may have taken it along.
      const isGroup = (id: number) =>
        before.some((item) => item.parentId === id) || before.find((item) => item.id === id)?.parentId === 0;
      const groupRemoved = remove.some(isGroup);

      const items = await readChecklist(ctx, TASKID).catch((e: unknown) => {
        throw new Error(`изменения отправлены, но перечитать чек-лист не удалось (проверь через bitrix_task_checklist): ${errorMessage(e)}`);
      });
      const byId = new Map(items.map((item) => [item.id, item]));
      const vanished = (id: number) => gone.has(id) && !byId.has(id);
      const notApplied = [
        ...added.filter((id) => !byId.has(id) && !groupRemoved).map((id) => `добавить ${id}`),
        ...rename.filter((r) => !vanished(r.itemId) && byId.get(r.itemId)?.title !== r.title).map((r) => `переименовать ${r.itemId}`),
        ...complete.filter((id) => !vanished(id) && byId.get(id)?.done !== true).map((id) => `отметить ${id}`),
        ...reopen.filter((id) => !vanished(id) && byId.get(id)?.done !== false).map((id) => `снять отметку ${id}`),
        ...remove.filter((id) => byId.has(id)).map((id) => `удалить ${id}`),
      ];
      if (notApplied.length > 0) {
        throw new Error(`Bitrix не применил: ${notApplied.join(", ")} — перечитай чек-лист (bitrix_task_checklist)`);
      }
      return { taskId: TASKID, added, items };
    },
  }),
  defineOperation({
    name: "task_plan",
    description:
      "⚠ МУТИРУЮЩИЙ. Задать ПЛАНИРУЕМЫЕ даты задачи: start — начало, end — завершение; ISO 8601 со смещением " +
      '(напр. "2026-11-10T09:00:00+03:00" или "…Z"); null — очистить; не передано — остаётся текущее значение. ' +
      "Нужно хотя бы одно; start не позже end. Привязка к рабочему времени и к срокам подзадач выключается. " +
      "Сроки видят все, кто видит задачу; правка видна в истории задачи. Ответ: { taskId, start, end } (UTC) — " +
      "даты перечитаны после записи.",
    mutating: true,
    // Up to three requests in a row.
    budget: "long",
    input: { taskId: idArg(), start: planDateArg(), end: planDateArg() },
    run: async (ctx, a) => {
      if (a.start === undefined && a.end === undefined) {
        throw new OpInputError("invalid arguments for task_plan — pass start and / or end");
      }
      let startPlanTs = a.start === undefined ? undefined : toTs(a.start);
      let endPlanTs = a.end === undefined ? undefined : toTs(a.end);
      const startAfterEnd = (start: number, end: number) => start > 0 && end > 0 && start > end;
      if (startPlanTs !== undefined && endPlanTs !== undefined && startAfterEnd(startPlanTs, endPlanTs)) {
        throw new OpInputError("invalid arguments for task_plan — start is after end");
      }
      // The update sets both dates: the one not passed is written back as it is now.
      if (startPlanTs === undefined || endPlanTs === undefined) {
        const current = await readPlan(ctx, a.taskId);
        startPlanTs ??= current.startPlanTs;
        endPlanTs ??= current.endPlanTs;
        if (startAfterEnd(startPlanTs, endPlanTs)) {
          throw new Error(`начало ${fromTs(startPlanTs)} позже завершения ${fromTs(endPlanTs)} — передай обе даты`);
        }
      }
      await ctx.call({
        ...PLAN_UPDATE,
        params: { task: { id: a.taskId, startPlanTs, endPlanTs, matchesWorkTime: false, matchesSubTasksTime: false } },
      });
      const actual = await readPlan(ctx, a.taskId).catch((e: unknown) => {
        throw new Error(`запись отправлена, но перечитать даты не удалось (проверь через bitrix_task_get_v2): ${errorMessage(e)}`);
      });
      if (actual.startPlanTs !== startPlanTs || actual.endPlanTs !== endPlanTs) {
        throw new Error(
          `Bitrix ответил успехом, но даты другие: сейчас start ${fromTs(actual.startPlanTs) ?? "нет"}, ` +
            `end ${fromTs(actual.endPlanTs) ?? "нет"}`,
        );
      }
      return { taskId: a.taskId, start: fromTs(startPlanTs), end: fromTs(endPlanTs) };
    },
  }),
];
