// Operations that link a task to other tasks: related tasks, the parent task, Gantt dependencies.
// Each request adds or drops only the named links, so the task's other relations stay untouched.
// None of them takes agent `params`: merged-in fields could widen a write beyond what the tool
// says it does.

import { z } from "zod";
import { MAX_BATCH, errorMessage } from "./batch.js";
import { REST_TASK_GET, numeric, parseResponse, reread, restMethod } from "./calls.js";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { TASK_RELATED, TASK_V2_GET, callTarget } from "./read.js";

const v2 = (action: string) => callTarget({ action, method: "POST", bodyType: "json" });
const RELATED_ADD = v2("tasks.v2.Task.Relation.Related.add");
const RELATED_DELETE = v2("tasks.v2.Task.Relation.Related.delete");
const CHILD_ADD = v2("tasks.v2.Task.Relation.Child.add");
const CHILD_DELETE = v2("tasks.v2.Task.Relation.Child.delete");
// The v2 Gantt.Dependence actions answer 22002 for any body on the portal checked, so classic REST.
const GANTT_ADD = restMethod("task.dependence.add");
const GANTT_DELETE = restMethod("task.dependence.delete");
const FINISH_START = 2;

// `ids` is required: an unexpected shape read as "nothing related" would turn a removal into a no-op.
const relatedResponse = z.object({ data: z.object({ ids: z.array(numeric) }) });
// Required too, and "0" means no parent as much as null does.
const parentResponse = z.object({
  result: z.object({ task: z.object({ parentId: numeric.nullable().transform((id) => id || null) }) }),
});
// The only read of Gantt links: one flag over all of the task's links, set on the dependent task.
// Required: an unexpected shape read as "no links" would confirm a removal that did not happen.
const ganttFlagResponse = z.object({ data: z.object({ containsGanttLinks: z.boolean() }) });

const RELATED_PAGE = 100;
const RELATED_RECHECK = "состояние связей неизвестно — перечитай их через bitrix_task_related перед повтором";

async function readRelated(ctx: OpContext, taskId: number) {
  // Subtasks of the related tasks are not links of this task.
  const params = { taskId, withIds: true, withCompleted: true, withSubTasks: false, navigation: { size: RELATED_PAGE } };
  const raw = await ctx.call({ ...TASK_RELATED, params });
  const ids = parseResponse(relatedResponse, raw, "tasks.v2.Task.Relation.Related.list").data.ids;
  // A full page may be a cut one: a removal or the loss check would then work on part of the list.
  if (ids.length >= RELATED_PAGE) throw new Error(`у задачи ${RELATED_PAGE} или больше связанных — правка недоступна`);
  return ids;
}

async function readParent(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REST_TASK_GET, params: { taskId, select: ["ID", "PARENT_ID"] } });
  return parseResponse(parentResponse, raw, "tasks.task.get").result.task.parentId;
}

async function hasGanttLinks(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...TASK_V2_GET, params: { task: { id: taskId } } });
  return parseResponse(ganttFlagResponse, raw, "tasks.v2.Task.get (containsGanttLinks)").data.containsGanttLinks;
}

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
      "с перечнем, в т.ч. если пропали связи, которых не было в remove. Задачи со 100 и более связанными не " +
      "правятся (список не читается целиком). Связи видят все, кто видит задачу; уведомляет ли Bitrix участников " +
      "о новой связи — не проверено. Текущий список — bitrix_task_related. " +
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

      // A failed request may still have been applied, wholly or for some of the ids.
      if (toAdd.length > 0) {
        await ctx.call({ ...RELATED_ADD, params: { taskId: a.taskId, tasks: taskList(toAdd), noOverride: false } }).catch((e: unknown) => {
          throw new Error(`добавить ${toAdd.join(", ")} не удалось: ${errorMessage(e)} — ${RELATED_RECHECK}`);
        });
      }
      if (toRemove.length > 0) {
        await ctx.call({ ...RELATED_DELETE, params: { taskId: a.taskId, tasks: taskList(toRemove) } }).catch((e: unknown) => {
          const added = toAdd.length > 0 ? `связи добавлены ${toAdd.join(", ")}, но ` : "";
          throw new Error(`${added}убрать ${toRemove.join(", ")} не удалось: ${errorMessage(e)} — ${RELATED_RECHECK}`);
        });
      }
      const actual = await readRelated(ctx, a.taskId).catch((e: unknown) => {
        throw new Error(`запись отправлена, но перечитать связи не удалось (проверь через bitrix_task_related): ${errorMessage(e)}`);
      });
      const notAdded = toAdd.filter((id) => !actual.includes(id));
      const notRemoved = toRemove.filter((id) => actual.includes(id));
      // Links the agent did not ask to drop must survive the write as well.
      const lost = current.filter((id) => !toRemove.includes(id) && !actual.includes(id));
      if (notAdded.length > 0 || notRemoved.length > 0 || lost.length > 0) {
        const parts = [
          ...(notAdded.length > 0 ? [`не добавлены ${notAdded.join(", ")}`] : []),
          ...(notRemoved.length > 0 ? [`не убраны ${notRemoved.join(", ")}`] : []),
          ...(lost.length > 0 ? [`пропали без запроса ${lost.join(", ")}`] : []),
        ];
        throw new Error(
          `правка связей применилась не так, как просили: ${parts.join("; ")} ` +
            `(до правки: ${current.join(", ") || "нет"}; сейчас: ${actual.join(", ") || "нет"})`,
        );
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
      "к новому; если задача могла остаться без прежнего родителя, ошибка называет его и вызов, которым его вернуть. Свои " +
      "подзадачи задачи и прочие её связи не трогаются. Задача появляется в списке подзадач родителя у всех, " +
      "кто его видит; уведомляет ли Bitrix участников о смене родителя — не проверено. Ответ: { taskId, parentId, previousParentId, changed } — parentId перечитан после записи.",
    mutating: true,
    // Up to four requests in a row.
    budget: "long",
    input: { taskId: idArg(), parentId: idArg().nullable() },
    run: async (ctx, a) => {
      if (a.parentId === a.taskId) throw new OpInputError("invalid arguments for task_parent — a task cannot be its own parent");
      const previousParentId = await readParent(ctx, a.taskId);
      if (previousParentId === a.parentId) return { taskId: a.taskId, parentId: a.parentId, previousParentId, changed: false };

      // Once the detach may have gone through, every failure tells how to get the old parent back.
      const restore =
        previousParentId === null
          ? ""
          : ` — прежний родитель ${previousParentId}; вернуть его: bitrix_task_parent { taskId: ${a.taskId}, parentId: ${previousParentId} }`;
      const tasks = taskList([a.taskId]);
      if (previousParentId !== null) {
        await ctx.call({ ...CHILD_DELETE, params: { taskId: previousParentId, tasks } }).catch((e: unknown) => {
          throw new Error(`отвязать от родителя ${previousParentId} не удалось: ${errorMessage(e)}; проверь родителя через bitrix_task_get${restore}`);
        });
      }
      if (a.parentId !== null) {
        await ctx.call({ ...CHILD_ADD, params: { taskId: a.parentId, tasks, noOverride: false, relationKind: "parent" } }).catch((e: unknown) => {
          if (previousParentId === null) throw e;
          throw new Error(
            `задача отвязана от родителя ${previousParentId}, но привязать к ${a.parentId} не удалось: ${errorMessage(e)}; ` +
              `сейчас у неё, вероятно, нет родителя${restore}`,
          );
        });
      }
      const parentId = await readParent(ctx, a.taskId).catch((e: unknown) => {
        throw new Error(`запись отправлена, но перечитать задачу не удалось (проверь родителя через bitrix_task_get): ${errorMessage(e)}${restore}`);
      });
      if (parentId !== a.parentId) {
        const lostPrevious = parentId !== previousParentId ? restore : "";
        throw new Error(`Bitrix не применил смену родителя (сейчас родитель: ${parentId ?? "нет"})${lostPrevious}`);
      }
      return { taskId: a.taskId, parentId, previousParentId, changed: true };
    },
  }),
  defineOperation({
    name: "task_gantt_link",
    description:
      "⚠ МУТИРУЮЩИЙ. Связь задач на диаграмме Ганта «окончание → начало»: dependentId начинается после " +
      "завершения taskId. По умолчанию связь добавляется; remove: true — удалить связь. type — только " +
      "\"finish_start\" (по умолчанию) и только при добавлении. Прочие связи задач не трогаются. Прочитать " +
      "отдельную связь нельзя: Bitrix сообщает только, есть ли у задачи dependentId хоть одна связь Ганта, — " +
      "по нему запись и проверяется. confirmed: true — подтверждено: после добавления связи появились, после " +
      "удаления не осталось ни одной. confirmed: false и note — подтвердить нельзя: при добавлении у задачи уже " +
      "были связи Ганта, при удалении у неё остаются другие. Если связей после добавления нет — ошибка. Связь " +
      "видят все, кто видит задачи; уведомляет ли Bitrix участников — не проверено. " +
      "Ответ: { taskId, dependentId, linked, confirmed, note? }.",
    mutating: true,
    // Up to three requests in a row.
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
      const link = { taskId: a.taskId, dependentId: a.dependentId };
      const pair = { taskIdFrom: a.taskId, taskIdTo: a.dependentId };
      const readAfter = () => reread(hasGanttLinks(ctx, a.dependentId), `bitrix_task_get_v2 задачи ${a.dependentId}`);

      if (a.remove) {
        // `result: []` comes back on success too, so only the flag confirms the write.
        await ctx.call({ ...GANTT_DELETE, params: pair });
        if (!(await readAfter())) return { ...link, linked: false, confirmed: true };
        return {
          ...link,
          linked: false,
          confirmed: false,
          note: "удаление отправлено, но у задачи остаются связи Ганта — подтвердить нельзя",
        };
      }
      const before = await hasGanttLinks(ctx, a.dependentId).catch((e: unknown) => {
        throw new Error(`не удалось прочитать связи Ганта задачи ${a.dependentId}: ${errorMessage(e)}; ничего не записано — повтор безопасен`);
      });
      await ctx.call({ ...GANTT_ADD, params: { ...pair, linkType: FINISH_START } });
      if (!(await readAfter())) throw new Error(`Bitrix ответил успехом, но не применил связь: у задачи ${a.dependentId} нет связей Ганта`);
      if (!before) return { ...link, linked: true, confirmed: true };
      return {
        ...link,
        linked: true,
        confirmed: false,
        note: "связь отправлена; у задачи уже были связи Ганта — подтвердить именно эту нельзя",
      };
    },
  }),
];
