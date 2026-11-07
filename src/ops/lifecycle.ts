// Closing and reopening tasks. Closing goes through the scrum project's Definition of Done the way
// the task card does, and never around it: when DoD applies, the criteria are only marked done in a
// second call the agent makes after the user has agreed to it.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorMessage, forEachTask, taskIdsArg } from "./batch.js";
import { readTaskStage } from "./board.js";
import { numeric, parseResponse, v2 } from "./calls.js";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { PROJECTS_GET, callTarget } from "./read.js";

const dod = (action: string) => callTarget({ action: `bitrix:tasks.scrum.doD.${action}`, method: "POST" });
const DOD_NECESSARY = dod("isNecessary");
const DOD_SETTINGS = dod("getSettings");
const DOD_LIST = dod("getList");
const DOD_SAVE = dod("saveList");
const STATUS_COMPLETE = v2("tasks.v2.Task.Status.complete");
const STATUS_RENEW = v2("tasks.v2.Task.Status.renew");

const CLOSED = 5;

// Only the known types: a group of any other is not taken for a non-scrum one, which would skip DoD.
const groupTypeResponse = z.object({ data: z.object({ TYPE: z.enum(["scrum", "project", "group"]) }) });
// A strict boolean: an unexpected answer read as "not needed" would close past DoD.
const necessaryResponse = z.object({ data: z.boolean() });
const settingsResponse = z.object({
  data: z.object({ types: z.array(z.object({ id: numeric, name: z.string(), dodRequired: z.enum(["Y", "N"]) })) }),
});
const listResponse = z.object({ data: z.object({ html: z.string() }) });

interface DodItem {
  copiedId: number;
  parentId: number;
  title: string;
  sortIndex: number;
  important: boolean;
  children: DodItem[];
}

const dodItem: z.ZodType<DodItem, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      FIELDS: z.object({
        COPIED_ID: numeric,
        PARENT_ID: numeric,
        TITLE: z.string(),
        SORT_INDEX: numeric,
        IS_IMPORTANT: z.boolean().optional(),
      }),
      DESCENDANTS: z.array(dodItem),
    })
    .transform(({ FIELDS: f, DESCENDANTS }) => ({
      copiedId: f.COPIED_ID,
      parentId: f.PARENT_ID,
      title: f.TITLE,
      sortIndex: f.SORT_INDEX,
      important: f.IS_IMPORTANT ?? false,
      children: DESCENDANTS,
    })),
);
// The top node is a nameless root; the criteria are its descendants.
const listData = z.object({ items: z.object({ DESCENDANTS: z.array(dodItem) }) });

// The object literal handed to `Object.assign(renderTo, …)` in the checklist's script, found by
// matching braces outside string literals: a criterion's title may contain braces of its own.
function renderData(html: string): string | null {
  const start = /Object\.assign\(\s*renderTo\s*,\s*\{/.exec(html);
  if (!start) return null;
  const from = start.index + start[0].length - 1;
  let depth = 0;
  let inString = false;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return html.slice(from, i + 1);
  }
  return null;
}

// DoD exists in scrum projects only; elsewhere the task card closes without asking for it.
async function isScrumGroup(ctx: OpContext, groupId: number) {
  const raw = await ctx.call({ ...PROJECTS_GET, params: { params: { groupId, select: ["ID", "TYPE"] } } });
  return parseResponse(groupTypeResponse, raw, "socialnetwork.api.workgroup.get").data.TYPE === "scrum";
}

async function readCriteria(ctx: OpContext, groupId: number, taskId: number, typeId: number): Promise<DodItem[]> {
  const raw = await ctx.call({ ...DOD_LIST, params: { groupId, taskId, typeId } });
  const { html } = parseResponse(listResponse, raw, "doD.getList").data;
  const literal = renderData(html);
  let parsed: unknown;
  try {
    parsed = literal === null ? null : JSON.parse(literal);
  } catch {
    parsed = null;
  }
  const items = listData.safeParse(parsed);
  if (!items.success) throw new Error(`не удалось прочитать критерии DoD типа ${typeId} из ответа Bitrix — закрой задачу в интерфейсе`);
  return items.data.items.DESCENDANTS;
}

async function readTypes(ctx: OpContext, groupId: number, taskId: number) {
  const raw = await ctx.call({ ...DOD_SETTINGS, params: { groupId, taskId, saveRequest: "N" } });
  return parseResponse(settingsResponse, raw, "doD.getSettings").data.types;
}

const flatten = (items: DodItem[]): DodItem[] => items.flatMap((item) => [item, ...flatten(item.children)]);

// A top-level node with children is a checklist group («Критерии готовности»), not a criterion to
// agree to; it is still saved with the tree in step 2.
const criteriaToShow = (items: DodItem[]) =>
  items.flatMap((item) =>
    item.children.length === 0
      ? [{ title: item.title }]
      : flatten(item.children).map(({ title }) => ({ title, group: item.title })),
  );

// What the checklist sends when every box is ticked: the whole tree, parents before children, each
// node under an id of the client's own making.
function completedTree(items: DodItem[], parentNodeId: string | 0 = 0): Array<Record<string, unknown>> {
  return items.flatMap((item) => {
    const nodeId = randomUUID().replace(/-/g, "").slice(0, 9);
    const own = {
      NODE_ID: nodeId,
      PARENT_NODE_ID: parentNodeId,
      COPIED_ID: item.copiedId,
      PARENT_ID: item.parentId,
      TITLE: item.title,
      SORT_INDEX: item.sortIndex,
      IS_COMPLETE: true,
      IS_IMPORTANT: item.important,
    };
    return [own, ...completedTree(item.children, nodeId)];
  });
}

async function closeAndCheck(ctx: OpContext, taskId: number, marked: boolean) {
  await ctx.call({ ...STATUS_COMPLETE, params: { task: { id: taskId }, completeWithChecklist: true } }).catch((e: unknown) => {
    if (!marked) throw e;
    throw new Error(`критерии DoD отмечены выполненными, но закрыть задачу не удалось: ${errorMessage(e)}`);
  });
  const { status } = await readTaskStage(ctx, taskId).catch((e: unknown) => {
    throw new Error(`закрытие отправлено, но перечитать задачу не удалось (проверь статус через bitrix_task_get): ${errorMessage(e)}`);
  });
  if (status !== CLOSED) throw new Error(`Bitrix ответил успехом, но задача не закрылась (статус ${status ?? "неизвестен"})`);
  return { taskId, status: CLOSED, changed: true };
}

export const LIFECYCLE_OPERATIONS: Operation[] = [
  defineOperation({
    name: "task_close",
    description:
      "⚠ МУТИРУЮЩИЙ. Закрыть (завершить) задачу. Definition of Done (DoD) scrum-проекта НЕ обходится — " +
      "закрытие в два вызова. Шаг 1: { taskId }. Если задача не в scrum-проекте или DoD для неё не нужен, она сразу закрывается. Если нужен — " +
      "задача НЕ закрывается, ответ { taskId, needsConfirmation: true, types: [{ id, name, required, items: [{ title, group? }] }] } — " +
      "типы задач проекта (required — DoD для типа обязателен) и критерии готовности каждого (group — название " +
      "группы чек-листа, в которой критерий; сама группа критерием не считается). Покажи пользователю " +
      "критерии и получи его ЯВНОЕ согласие отметить их выполненными для выбранного типа; без согласия шаг 2 не " +
      "вызывай и сам за пользователя не решай. Тип тоже выбирает пользователь: тип с required: false закроет задачу " +
      "без обязательных критериев — и его бери только с согласия пользователя. Шаг 2: { taskId, typeId, confirmItems: true } — все критерии типа " +
      "отмечаются выполненными, затем задача закрывается. После закрытия статус перечитывается; если задача не " +
      "закрылась — ошибка. Уже закрытая задача не трогается (changed: false). Закрытие видят все, кто видит задачу; " +
      "участники получают уведомление. Ответ: { taskId, status, changed, typeId? } (status 5 — завершена). " +
      "Возобновить — bitrix_task_reopen.",
    mutating: true,
    // Step 1: four requests plus one per DoD type; step 2: seven.
    budget: "long",
    input: { taskId: idArg(), typeId: idArg().optional(), confirmItems: z.literal(true).optional() },
    run: async (ctx, a) => {
      if ((a.typeId === undefined) !== (a.confirmItems === undefined)) {
        throw new OpInputError(
          "invalid arguments for task_close — typeId and confirmItems: true go together (step 2, after the user agreed to mark the criteria)",
        );
      }
      const { taskId } = a;
      const before = await readTaskStage(ctx, taskId);
      if (before.status === CLOSED) return { taskId, status: CLOSED, changed: false };
      // Only an explicit 0 / null means "no project"; a missing field must not let the task past DoD.
      if (before.groupId === undefined) throw new Error("tasks.task.get не вернул проект задачи — закрытие не выполнено");
      const groupId = before.groupId && (await isScrumGroup(ctx, before.groupId)) ? before.groupId : null;

      if (a.typeId === undefined) {
        if (groupId !== null) {
          const raw = await ctx.call({ ...DOD_NECESSARY, params: { groupId, taskId } });
          if (parseResponse(necessaryResponse, raw, "doD.isNecessary").data) {
            const types = [];
            for (const type of await readTypes(ctx, groupId, taskId)) {
              const items = criteriaToShow(await readCriteria(ctx, groupId, taskId, type.id));
              types.push({ id: type.id, name: type.name, required: type.dodRequired === "Y", items });
            }
            if (types.length === 0) throw new Error("Bitrix требует DoD, но не вернул ни одного типа задач — закрой задачу в интерфейсе");
            return { taskId, needsConfirmation: true, types };
          }
        }
        return closeAndCheck(ctx, taskId, false);
      }

      const { typeId } = a;
      if (groupId === null) throw new Error(`задача ${taskId} не в scrum-проекте — DoD к ней не относится, закрой её без typeId и confirmItems`);
      const types = await readTypes(ctx, groupId, taskId);
      if (!types.some((t) => t.id === typeId)) {
        const available = types.map((t) => `${t.id} «${t.name}»`).join(", ") || "нет";
        throw new Error(`типа ${typeId} нет в DoD проекта; есть: ${available}`);
      }
      const items = completedTree(await readCriteria(ctx, groupId, taskId, typeId));
      await ctx.call({ ...DOD_SAVE, params: { typeId, taskId, groupId, items } });
      return { ...(await closeAndCheck(ctx, taskId, true)), typeId };
    },
  }),
  defineOperation({
    name: "task_reopen",
    description:
      "⚠ МУТИРУЮЩИЙ. Возобновить завершённые задачи (статус 5): taskIds — массив id (1..50). Задача, которая не " +
      "завершена, не трогается (changed: false). После возобновления статус перечитывается; если задача осталась " +
      "завершённой — ok: false. Смену статуса видят все, кто видит задачу; участники получают уведомление. Задачи " +
      "обрабатываются по очереди; ошибка одной не останавливает остальные. " +
      "Ответ: { results: [{ taskId, ok, status, changed, error? }] }.",
    mutating: true,
    budget: "long",
    input: { taskIds: taskIdsArg() },
    run: (ctx, a) =>
      forEachTask(a.taskIds, async (taskId) => {
        const before = await readTaskStage(ctx, taskId);
        if (before.status !== CLOSED) return { status: before.status ?? null, changed: false };
        await ctx.call({ ...STATUS_RENEW, params: { task: { id: taskId } } });
        const { status } = await readTaskStage(ctx, taskId).catch((e: unknown) => {
          throw new Error(`возобновление отправлено, но перечитать задачу не удалось (проверь статус через bitrix_task_get): ${errorMessage(e)}`);
        });
        if (status === CLOSED) throw new Error("Bitrix ответил успехом, но задача осталась завершённой");
        return { status: status ?? null, changed: true };
      }),
  }),
];
