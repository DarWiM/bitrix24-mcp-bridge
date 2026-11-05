// Operations that link a task to other tasks: related tasks, the parent task, Gantt dependencies.
// Each request adds or drops only the named links, so the task's other relations stay untouched.
// None of them takes agent `params`: merged-in fields could widen a write beyond what the tool
// says it does.

import { z } from "zod";
import { MAX_BATCH, errorMessage } from "./batch.js";
import { REST_TASK_GET, numeric, parseResponse } from "./calls.js";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { TASK_RELATED, callTarget } from "./read.js";

const v2 = (action: string) => callTarget({ action, method: "POST", bodyType: "json" });
const RELATED_ADD = v2("tasks.v2.Task.Relation.Related.add");
const RELATED_DELETE = v2("tasks.v2.Task.Relation.Related.delete");
const CHILD_ADD = v2("tasks.v2.Task.Relation.Child.add");
const CHILD_DELETE = v2("tasks.v2.Task.Relation.Child.delete");
const GANTT_CHECK = v2("tasks.v2.Task.Gantt.Dependence.check");
const GANTT_ADD = v2("tasks.v2.Task.Gantt.Dependence.add");
const GANTT_DELETE = v2("tasks.v2.Task.Gantt.Dependence.delete");

// `ids` is required: an unexpected shape read as "nothing related" would turn a removal into a no-op.
const relatedResponse = z.object({ data: z.object({ ids: z.array(numeric) }) });
// Required too, and "0" means no parent as much as null does.
const parentResponse = z.object({
  result: z.object({ task: z.object({ parentId: numeric.nullable().transform((id) => id || null) }) }),
});
// There is no read for Gantt links, so only this answer tells a done write from an ignored one.
const confirmedResponse = z.object({ data: z.literal(true) });

async function readRelated(ctx: OpContext, taskId: number) {
  // Subtasks of the related tasks are not links of this task.
  const params = { taskId, withIds: true, withCompleted: true, withSubTasks: false, navigation: { size: 100 } };
  const raw = await ctx.call({ ...TASK_RELATED, params });
  return parseResponse(relatedResponse, raw, "tasks.v2.Task.Relation.Related.list").data.ids;
}

async function readParent(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REST_TASK_GET, params: { taskId, select: ["ID", "PARENT_ID"] } });
  return parseResponse(parentResponse, raw, "tasks.task.get").result.task.parentId;
}

const confirmed = (raw: unknown) => confirmedResponse.safeParse(raw).success;
const taskList = (ids: number[]) => ids.map((id) => ({ id }));
const relatedIdsArg = () => z.array(idArg()).max(MAX_BATCH).optional();

export const RELATION_OPERATIONS: Operation[] = [
  defineOperation({
    name: "task_related_edit",
    description:
      "⚠ МУТИРУЮЩИЙ. Добавить / убрать СВЯЗАННЫЕ задачи (блок «Связанные задачи» в карточке). add / remove — " +
      "массивы id задач; нужен хотя бы один непустой. Связи задачи читаются заново: добавляются только те, " +
      "которых нет, убираются только те, что есть; остальные связи не трогаются; если менять нечего, запись " +
      "не делается (changed: false). После записи список перечитывается; если Bitrix применил не всё — ошибка " +
      "с перечнем. Связи видят все, кто видит задачу. Текущий список — bitrix_task_related. " +
      "Ответ: { taskId, related, changed } — related — id связанных задач после записи.",
    mutating: true,
    // Up to four requests in a row.
    budget: "long",
    input: { taskId: idArg(), add: relatedIdsArg(), remove: relatedIdsArg() },
    run: async (ctx, a) => {
      const add = a.add ?? [];
      const remove = a.remove ?? [];
      const invalid = (message: string) => new OpInputError(`invalid arguments for task_related_edit — ${message}`);
      if (add.length === 0 && remove.length === 0) throw invalid("pass a non-empty add or remove");
      if (add.includes(a.taskId) || remove.includes(a.taskId)) throw invalid("a task cannot be related to itself");
      const both = add.find((id) => remove.includes(id));
      if (both !== undefined) throw invalid(`task ${both} is in both add and remove`);

      const current = await readRelated(ctx, a.taskId);
      const toAdd = [...new Set(add)].filter((id) => !current.includes(id));
      const toRemove = [...new Set(remove)].filter((id) => current.includes(id));
      if (toAdd.length === 0 && toRemove.length === 0) return { taskId: a.taskId, related: current, changed: false };

      if (toAdd.length > 0) {
        await ctx.call({ ...RELATED_ADD, params: { taskId: a.taskId, tasks: taskList(toAdd), noOverride: false } });
      }
      if (toRemove.length > 0) {
        await ctx.call({ ...RELATED_DELETE, params: { taskId: a.taskId, tasks: taskList(toRemove) } }).catch((e: unknown) => {
          if (toAdd.length === 0) throw e;
          throw new Error(`связи добавлены ${toAdd.join(", ")}, но убрать ${toRemove.join(", ")} не удалось: ${errorMessage(e)}`);
        });
      }
      const actual = await readRelated(ctx, a.taskId).catch((e: unknown) => {
        throw new Error(`запись отправлена, но перечитать связи не удалось (проверь через bitrix_task_related): ${errorMessage(e)}`);
      });
      const notAdded = toAdd.filter((id) => !actual.includes(id));
      const notRemoved = toRemove.filter((id) => actual.includes(id));
      if (notAdded.length > 0 || notRemoved.length > 0) {
        const parts = [
          ...(notAdded.length > 0 ? [`добавить ${notAdded.join(", ")}`] : []),
          ...(notRemoved.length > 0 ? [`убрать ${notRemoved.join(", ")}`] : []),
        ];
        throw new Error(`Bitrix не применил: ${parts.join("; ")} (сейчас связаны: ${actual.join(", ") || "нет"})`);
      }
      return { taskId: a.taskId, related: actual, changed: true };
    },
  }),
  defineOperation({
    name: "task_parent",
    description:
      "⚠ МУТИРУЮЩИЙ. Сделать задачу ПОДЗАДАЧЕЙ другой: parentId — id новой родительской задачи; null — " +
      "отвязать от родителя (задача становится самостоятельной). Текущий родитель читается заново; если он " +
      "уже тот, запись не делается (changed: false). Смена родителя — два шага: отвязка от старого, привязка " +
      "к новому; если второй шаг не прошёл, задача остаётся без родителя, и ошибка называет старого. Свои " +
      "подзадачи задачи и прочие её связи не трогаются. Задача появляется в списке подзадач родителя у всех, " +
      "кто его видит. Ответ: { taskId, parentId, previousParentId, changed } — parentId перечитан после записи.",
    mutating: true,
    // Up to four requests in a row.
    budget: "long",
    input: { taskId: idArg(), parentId: idArg().nullable() },
    run: async (ctx, a) => {
      if (a.parentId === a.taskId) throw new OpInputError("invalid arguments for task_parent — a task cannot be its own parent");
      const previousParentId = await readParent(ctx, a.taskId);
      if (previousParentId === a.parentId) return { taskId: a.taskId, parentId: a.parentId, previousParentId, changed: false };

      const tasks = taskList([a.taskId]);
      if (previousParentId !== null) await ctx.call({ ...CHILD_DELETE, params: { taskId: previousParentId, tasks } });
      if (a.parentId !== null) {
        await ctx.call({ ...CHILD_ADD, params: { taskId: a.parentId, tasks, noOverride: false, relationKind: "parent" } }).catch((e: unknown) => {
          if (previousParentId === null) throw e;
          throw new Error(
            `задача отвязана от родителя ${previousParentId}, но привязать к ${a.parentId} не удалось: ${errorMessage(e)} — ` +
              `сейчас у неё нет родителя; вернуть прежнего: bitrix_task_parent { taskId: ${a.taskId}, parentId: ${previousParentId} }`,
          );
        });
      }
      const parentId = await readParent(ctx, a.taskId).catch((e: unknown) => {
        throw new Error(`запись отправлена, но перечитать задачу не удалось (проверь родителя через bitrix_task_get): ${errorMessage(e)}`);
      });
      if (parentId !== a.parentId) throw new Error(`Bitrix не применил смену родителя (сейчас родитель: ${parentId ?? "нет"})`);
      return { taskId: a.taskId, parentId, previousParentId, changed: true };
    },
  }),
  defineOperation({
    name: "task_gantt_link",
    description:
      "⚠ МУТИРУЮЩИЙ. Связь задач на диаграмме Ганта «окончание → начало»: dependentId начинается после " +
      "завершения taskId. По умолчанию связь добавляется (сначала Bitrix проверяет, допустима ли она, — " +
      "при отказе ничего не записывается); remove: true — удалить связь. type — только \"finish_start\" " +
      "(по умолчанию) и только при добавлении. Прочие связи задач не трогаются. Связь видят все, кто видит " +
      "задачи. Прочитать связи Ганта инструментом нельзя: успех — это подтверждение Bitrix. " +
      "Ответ: { taskId, dependentId, linked }.",
    mutating: true,
    // Two requests in a row.
    budget: "long",
    input: {
      taskId: idArg(),
      dependentId: idArg(),
      remove: z.boolean().optional(),
      type: z.enum(["finish_start"]).optional(),
    },
    run: async (ctx, a) => {
      const invalid = (message: string) => new OpInputError(`invalid arguments for task_gantt_link — ${message}`);
      if (a.dependentId === a.taskId) throw invalid("a task cannot depend on itself");
      if (a.remove && a.type !== undefined) throw invalid("type applies only when adding a link");
      const ganttLink = { taskId: a.taskId, dependentId: a.dependentId };

      if (a.remove) {
        if (!confirmed(await ctx.call({ ...GANTT_DELETE, params: { ganttLink } }))) {
          throw new Error("запрос отправлен, но Bitrix не подтвердил удаление связи — проверь диаграмму Ганта");
        }
        return { ...ganttLink, linked: false };
      }
      if (!confirmed(await ctx.call({ ...GANTT_CHECK, params: { ganttLink } }))) {
        throw new Error("Bitrix не разрешает эту связь (проверка не пройдена) — ничего не записано");
      }
      if (!confirmed(await ctx.call({ ...GANTT_ADD, params: { ganttLink: { ...ganttLink, type: a.type ?? "finish_start" } } }))) {
        throw new Error("запрос отправлен, но Bitrix не подтвердил связь — проверь диаграмму Ганта");
      }
      return { ...ganttLink, linked: true };
    },
  }),
];
