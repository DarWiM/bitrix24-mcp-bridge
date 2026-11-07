// Operations that change task content or people, create tasks or move them on the scrum board.
// None of them takes agent `params`: merged-in fields could widen a write beyond what the tool
// says it does.

import { z } from "zod";
import { MAX_BATCH, errorMessage, forEachTask, forEachTaskVetted, taskIdsArg } from "./batch.js";
import {
  activeSprintColumns,
  columnArg,
  currentUserId,
  moveToColumn,
  perGroup,
  readBacklogId,
  readGroupStages,
  readScrumTask,
  readTaskStage,
  refuseClosingColumns,
  targetColumn,
  type SprintColumn,
} from "./board.js";
import { REST_TASK_GET, mayHaveHappened, numeric, parseResponse, parseTaskCard, reread, restMethod, v2 } from "./calls.js";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { TASK_V2_GET, callTarget } from "./read.js";

const TASK_UPDATE = restMethod("tasks.task.update");
const TASK_DELEGATE = restMethod("tasks.task.delegate");
const USER_GET = restMethod("user.get");
// Changes only the container (backlog / sprint): the task is not on the sprint board yet.
const SCRUM_TASK_UPDATE = restMethod("tasks.api.scrum.task.update");
const BOARD_ADD = restMethod("tasks.api.scrum.kanban.addTask");
// What the board's own «+» sends: the task is born in the sprint column, as when created in the UI.
const BOARD_CREATE = callTarget({
  endpoint: "/bitrix/services/main/ajax.php?mode=class&c=bitrix%3Atasks.kanban&action=addTask",
  method: "POST",
});
// The official tasks.task.result.add exists in REST 3.0 only, which the session refuses.
const RESULT_ADD = v2("tasks.v2.Task.Result.add");

export const DESCRIPTION_MAX = 100_000;
const RESULT_MAX = 20_000;
// b_tasks.TITLE is varchar(255).
const TITLE_MAX = 255;

// `description` is required, not optional: reading an unexpected shape as "empty" would make
// append overwrite the whole description with the new text.
const descriptionResponse = z.object({ data: z.object({ description: z.string().nullable() }) });
const boardCreateResponse = z.object({ data: z.object({ id: numeric, columnId: numeric.nullish() }) });
const resultAddResponse = z.object({ data: z.array(z.object({ id: numeric })).min(1) });
const responsibleResponse = z.object({ result: z.object({ task: z.object({ responsibleId: numeric }) }) });
// The list is required: an unexpected shape read as "nobody" would make add drop everyone else.
const membersResponse = (key: "accomplices" | "auditors") =>
  z.object({ result: z.object({ task: z.object({ [key]: z.array(numeric) }) }) });
const optionalText = z.string().nullish().transform((v) => v ?? "");
const usersResponse = z.object({
  result: z.array(
    z.object({ ID: numeric, NAME: optionalText, LAST_NAME: optionalText, ACTIVE: z.boolean(), WORK_POSITION: optionalText }),
  ),
});

// Raw BBCode, `[disk file id=…]` included — what a point-edit has to write back untouched.
export async function readDescription(ctx: OpContext, taskId: number): Promise<string> {
  const raw = await ctx.call({ ...TASK_V2_GET, params: { task: { id: taskId } } });
  return parseTaskCard(descriptionResponse, raw, "tasks.v2.Task.get (description)", taskId).data.description ?? "";
}

const DESCRIPTION_MAY_HAVE_CHANGED = "описание могло измениться — сверь через bitrix_task_get_v2 перед повтором";

// tasks.task.update answers success without saying what it stored, so the description is read back;
// its answer itself is not looked at.
export async function writeDescription(ctx: OpContext, taskId: number, text: string) {
  const write = ctx.call({ ...TASK_UPDATE, params: { taskId, fields: { DESCRIPTION: text } } });
  await mayHaveHappened(write, z.unknown(), "tasks.task.update", DESCRIPTION_MAY_HAVE_CHANGED);
  const stored = await reread(readDescription(ctx, taskId), "bitrix_task_get_v2");
  if (stored !== text) {
    throw new Error(
      `Bitrix ответил успехом, но описание после записи другое (символов отправлено: ${text.length}, сейчас: ${stored.length}) — ` +
        "сверь через bitrix_task_get_v2",
    );
  }
  return { taskId, length: stored.length };
}

async function readResponsible(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REST_TASK_GET, params: { taskId, select: ["ID", "RESPONSIBLE_ID"] } });
  return parseTaskCard(responsibleResponse, raw, "tasks.task.get", taskId).result.task;
}

const userIdsArg = () => z.array(idArg()).max(MAX_BATCH).optional();

// Accomplices and auditors: Bitrix replaces the whole list, so each task's own list is read and
// edited rather than one list being written to every task of the batch.
function memberListOperation(def: { name: string; field: "ACCOMPLICES" | "AUDITORS"; key: "accomplices" | "auditors"; description: string }) {
  const response = membersResponse(def.key);
  const readMembers = async (ctx: OpContext, taskId: number) => {
    const raw = await ctx.call({ ...REST_TASK_GET, params: { taskId, select: ["ID", def.field] } });
    return parseTaskCard(response, raw, "tasks.task.get", taskId).result.task[def.key];
  };
  return defineOperation({
    name: def.name,
    description: def.description,
    mutating: true,
    budget: "long",
    input: { taskIds: taskIdsArg(), add: userIdsArg(), remove: userIdsArg() },
    run: async (ctx, a) => {
      const add = a.add ?? [];
      const remove = new Set(a.remove ?? []);
      if (add.length === 0 && remove.size === 0) {
        throw new OpInputError(`invalid arguments for ${def.name} — pass a non-empty add or remove`);
      }
      const both = add.find((id) => remove.has(id));
      if (both !== undefined) throw new OpInputError(`invalid arguments for ${def.name} — user ${both} is in both add and remove`);
      return forEachTask(a.taskIds, async (taskId) => {
        const current = await readMembers(ctx, taskId);
        const next = current.filter((id) => !remove.has(id));
        for (const id of add) if (!next.includes(id)) next.push(id);
        const changed = next.length !== current.length || next.some((id, i) => id !== current[i]);
        if (!changed) return { [def.key]: current, changed };
        // An empty array vanishes from the form body and Bitrix then rejects the call; "" clears.
        await ctx.call({ ...TASK_UPDATE, params: { taskId, fields: { [def.field]: next.length > 0 ? next : "" } } });
        // Bitrix may answer success and still keep a list of its own (e.g. refuse a user).
        const actual = await readMembers(ctx, taskId).catch((e: unknown) => {
          throw new Error(`запись отправлена, но перечитать задачу не удалось (проверь список через bitrix_task_get): ${errorMessage(e)}`);
        });
        const notAdded = next.filter((id) => !actual.includes(id));
        const notRemoved = actual.filter((id) => !next.includes(id));
        if (notAdded.length > 0 || notRemoved.length > 0) {
          const parts = [
            ...(notAdded.length > 0 ? [`добавить ${notAdded.join(", ")}`] : []),
            ...(notRemoved.length > 0 ? [`убрать ${notRemoved.join(", ")}`] : []),
          ];
          throw new Error(`Bitrix не применил: ${parts.join("; ")} (сейчас в списке: ${actual.join(", ") || "никого"})`);
        }
        return { [def.key]: actual, changed };
      });
    },
  });
}

const RETRY_FROM_BACKLOG = "верни её в бэклог (bitrix_task_to_backlog) и повтори";
const NO_FINISH_COLUMN = "Колонку типа FINISH указать нельзя (Bitrix завершил бы задачу в обход Definition of Done) — закрывай через bitrix_task_close.";
const CREATE_MAY_EXIST = "задача могла создаться, проверь доску спринта перед повтором";
const RESULT_MAY_EXIST = "результат мог добавиться — проверь bitrix_task_get / карточку задачи перед повтором";

async function placeInSprint(
  ctx: OpContext,
  taskId: number,
  { fromBacklog, sprintId, target }: { fromBacklog: boolean; sprintId: number; target: SprintColumn },
) {
  refuseClosingColumns([target]);
  if (fromBacklog) {
    await ctx.call({ ...SCRUM_TASK_UPDATE, params: { id: taskId, fields: { entityId: sprintId } } });
    // Without it movetask "succeeds" and changes nothing. It does not set the column itself.
    await ctx.call({ ...BOARD_ADD, params: { sprintId, taskId, stageId: target.id } }).catch((e: unknown) => {
      throw new Error(`задача перенесена в спринт ${sprintId}, но не поставлена на его доску (${errorMessage(e)}) — ${RETRY_FROM_BACKLOG}`);
    });
    const placed = await readScrumTask(ctx, taskId).catch((e: unknown) => {
      throw new Error(`перенос в спринт отправлен, но перечитать задачу не удалось (проверь через bitrix_task_scrum_info): ${errorMessage(e)}`);
    });
    if (placed.entityId !== sprintId) {
      throw new Error(`Bitrix ответил успехом, но задача не в спринте ${sprintId} (сейчас в ${placed.entityId})`);
    }
  }
  // Once in the sprint a retry takes the "already in the sprint" branch and never adds the task to
  // the board, so a task left off it has to go back to the backlog first.
  const moved = await moveToColumn(ctx, taskId, target, fromBacklog ? RETRY_FROM_BACKLOG : undefined);
  return { sprintId, ...moved, fromBacklog };
}

const RETRY_TO_BACKLOG = "повтори bitrix_task_to_backlog — у задачи, уже стоящей в бэклоге, он переставит только стадию";

// Moving the scrum item leaves STAGE_ID on the sprint column. movetask answers false for a backlog
// task; a plain field update does what the UI's drag into the backlog ends up with.
async function leaveSprintColumn(ctx: OpContext, taskId: number, start: { id: number; name: string }) {
  await ctx.call({ ...TASK_UPDATE, params: { taskId, fields: { STAGE_ID: start.id } } }).catch((e: unknown) => {
    throw new Error(`задача в бэклоге, но осталась в колонке спринта (${errorMessage(e)}) — ${RETRY_TO_BACKLOG}`);
  });
  const { stageId } = await readTaskStage(ctx, taskId).catch((e: unknown) => {
    throw new Error(`стадия отправлена, но перечитать задачу не удалось (проверь через bitrix_task_get): ${errorMessage(e)}`);
  });
  if (stageId !== start.id) {
    throw new Error(`Bitrix ответил успехом, но задача в стадии ${stageId ?? "?"}, а не «${start.name}» (${start.id}) — ${RETRY_TO_BACKLOG}`);
  }
  return { stageId: start.id };
}

const MEMBERS_HINT =
  "add / remove — массивы userId (найти id по фамилии — bitrix_user_find); нужен хотя бы один непустой. " +
  "Список читается у каждой задачи заново, записывается целиком и перечитывается; если менять нечего, " +
  "запись не делается (changed: false). Если Bitrix применил не всё, задача ok: false с перечнем. Задачи обрабатываются по очереди; ошибка одной не останавливает остальные.";

const DESCRIPTION_REREAD =
  "После записи описание перечитывается; если оно не то, что записано, — ошибка. Ответ: { taskId, length } — length " +
  "перечитанного описания. ";

export const DESCRIPTION_FORMAT =
  "Формат — BBCode: [b] [i] [u] [s], [url=…]…[/url], [user=ID]Имя[/user], списки [list] / [list=1] " +
  "с пунктами [*], [quote], [code], [spoiler=Заголовок]…[/spoiler], таблицы [table][tr][th]/[td]. " +
  "Вложения [disk file id=…] в описании не трогай — это прикреплённые файлы.";

export const WRITE_OPERATIONS: Operation[] = [
  defineOperation({
    name: "task_description_set",
    description:
      "⚠ МУТИРУЮЩИЙ. ЗАМЕНИТЬ описание задачи целиком (text — новое описание; пустая строка очищает). " +
      "Чтобы ДОПИСАТЬ к существующему — bitrix_task_description_append, поправить фрагмент — " +
      "bitrix_task_description_replace. Правка видна в истории задачи. " +
      DESCRIPTION_REREAD +
      DESCRIPTION_FORMAT,
    mutating: true,
    budget: "long",
    input: { taskId: idArg(), text: z.string().max(DESCRIPTION_MAX) },
    run: (ctx, a) => writeDescription(ctx, a.taskId, a.text),
  }),
  defineOperation({
    name: "task_description_append",
    description:
      "⚠ МУТИРУЮЩИЙ. ДОПИСАТЬ text в конец описания задачи через пустую строку; всё, что уже есть " +
      "(файлы [disk file id=…], таблицы, списки), остаётся как было. Правка видна в истории задачи. " +
      DESCRIPTION_REREAD +
      DESCRIPTION_FORMAT,
    mutating: true,
    // A read, the write and a re-read.
    budget: "long",
    input: { taskId: idArg(), text: z.string().min(1).max(DESCRIPTION_MAX) },
    run: async (ctx, a) => {
      const current = (await readDescription(ctx, a.taskId)).trimEnd();
      return writeDescription(ctx, a.taskId, current ? `${current}\n\n${a.text}` : a.text);
    },
  }),
  defineOperation({
    name: "sprint_columns",
    description:
      "Колонки доски АКТИВНОГО спринта scrum-проекта (read-only), по порядку на доске: " +
      "{ groupId, sprintId, columns: [{ id, name, type }] }. groupId — id проекта (GROUP_ID задачи). " +
      "type — NEW / WORK / FINISH; у пользовательских колонок (напр. «Testing») type пустой. " +
      "Не путать с task.stages.get: тот отдаёт старый канбан группы, а не колонки спринта.",
    mutating: false,
    // Two requests in a row.
    budget: "long",
    input: { groupId: idArg() },
    run: async (ctx, a) => ({ groupId: a.groupId, ...(await activeSprintColumns(ctx, a.groupId)) }),
  }),
  defineOperation({
    name: "task_move",
    description:
      "⚠ МУТИРУЮЩИЙ. Перенести задачи (taskIds — до 50) в колонку доски активного спринта их проекта. " +
      "column — id колонки или её название (без учёта регистра); список колонок — bitrix_sprint_columns. " +
      `${NO_FINISH_COLUMN} Если колонка хоть у одной задачи — FINISH, отказ всего вызова, ни одна задача не тронута. ` +
      "Работает только для задач, которые уже на доске спринта (не в бэклоге). Перенос может " +
      "переоткрыть закрытую задачу — смотри status в ответе. Сначала читаются все задачи, затем они переносятся по " +
      "очереди; ошибка одной не останавливает остальные. Ответ: { results: [{ taskId, ok, error?, stageId, column, status }] }.",
    mutating: true,
    // Up to five requests per task.
    budget: "long",
    input: { taskIds: taskIdsArg(), column: columnArg() },
    run: async (ctx, a) => {
      const sprintOf = perGroup((groupId) => activeSprintColumns(ctx, groupId));
      return forEachTaskVetted(a.taskIds, {
        prepare: async (taskId) => {
          const task = await readTaskStage(ctx, taskId);
          if (!task.groupId) throw new Error(`задача ${taskId} не в проекте — колонки спринта есть только у задач scrum-проекта`);
          const { columns } = await sprintOf(task.groupId);
          return targetColumn(columns, a.column);
        },
        vet: refuseClosingColumns,
        apply: (taskId, target) => moveToColumn(ctx, taskId, target),
      });
    },
  }),
  defineOperation({
    name: "task_to_sprint",
    description:
      "⚠ МУТИРУЮЩИЙ. Поставить задачи (taskIds — до 50) на доску АКТИВНОГО спринта их scrum-проекта: " +
      "задача из бэклога переносится в спринт и ставится в колонку, задача, уже стоящая в активном спринте, " +
      "просто переносится в колонку. column — id колонки или её название (без учёта регистра); без него — " +
      `колонка типа NEW; список колонок — bitrix_sprint_columns. ${NO_FINISH_COLUMN} Если колонка хоть у одной ` +
      "задачи — FINISH, отказ всего вызова, ни одна задача не тронута. Задачи других спринтов (запланированных, " +
      "завершённых) не трогаются — ошибка. Изменение видят все участники проекта на scrum-доске; перенос может " +
      "переоткрыть закрытую задачу — смотри status в ответе. Сначала читаются все задачи, затем они обрабатываются " +
      "по очереди; ошибка одной не останавливает остальные. Ответ: { results: [{ taskId, ok, error?, sprintId, stageId, column, status, " +
      "fromBacklog }] } — после переноса колонка перечитывается, а у задачи из бэклога перечитывается ещё и то, " +
      "что она теперь в спринте.",
    mutating: true,
    // Up to six requests per task, three more per project.
    budget: "long",
    input: { taskIds: taskIdsArg(), column: columnArg().optional() },
    run: async (ctx, a) => {
      const backlogOf = perGroup((groupId) => readBacklogId(ctx, groupId));
      const sprintOf = perGroup((groupId) => activeSprintColumns(ctx, groupId));
      return forEachTaskVetted(a.taskIds, {
        prepare: async (taskId) => {
          const task = await readScrumTask(ctx, taskId);
          const backlogId = await backlogOf(task.groupId);
          const { sprintId, columns } = await sprintOf(task.groupId);
          const fromBacklog = task.entityId === backlogId;
          if (!fromBacklog && task.entityId !== sprintId) {
            throw new Error(
              `задача ${taskId} не в бэклоге и не в активном спринте ${sprintId} (сейчас в ${task.entityId}) — ` +
                "переносить задачи между спринтами эта операция не умеет",
            );
          }
          return { fromBacklog, sprintId, target: targetColumn(columns, a.column) };
        },
        vet: (prepared) => refuseClosingColumns(prepared.map((p) => p.target)),
        apply: (taskId, prepared) => placeInSprint(ctx, taskId, prepared),
      });
    },
  }),
  defineOperation({
    name: "task_to_backlog",
    description:
      "⚠ МУТИРУЮЩИЙ. Вернуть задачи (taskIds — до 50) в БЭКЛОГ их scrum-проекта; с доски спринта они " +
      "пропадают — это видят все участники проекта. Задача уходит из колонки спринта в стартовую стадию " +
      "канбана проекта, как при переносе в веб-интерфейсе. Задача, которая уже в бэклоге, но всё ещё числится " +
      "в колонке спринта, только переставляется в эту стадию; остальные задачи бэклога не трогаются " +
      "(changed: false). Задачи обрабатываются по очереди; ошибка одной не останавливает остальные. " +
      "Ответ: { results: [{ taskId, ok, error?, backlogId, stageId, changed }] } — положение и стадия перечитаны после переноса.",
    mutating: true,
    budget: "long",
    input: { taskIds: taskIdsArg() },
    run: async (ctx, a) => {
      const backlogOf = perGroup((groupId) => readBacklogId(ctx, groupId));
      const stagesOf = perGroup((groupId) => readGroupStages(ctx, groupId));
      return forEachTask(a.taskIds, async (taskId) => {
        const task = await readScrumTask(ctx, taskId);
        const backlogId = await backlogOf(task.groupId);
        const stages = await stagesOf(task.groupId);
        if (task.entityId === backlogId) {
          const { stageId } = await readTaskStage(ctx, taskId);
          // 0 turns up on backlog tasks too and is left as Bitrix keeps it.
          if (!stageId || stages.ids.has(stageId)) return { backlogId, stageId: stageId ?? 0, changed: false };
          return { backlogId, ...(await leaveSprintColumn(ctx, taskId, stages.start)), changed: true };
        }
        await ctx.call({ ...SCRUM_TASK_UPDATE, params: { id: taskId, fields: { entityId: backlogId } } });
        const after = await readScrumTask(ctx, taskId).catch((e: unknown) => {
          throw new Error(`перенос отправлен, но перечитать задачу не удалось (проверь через bitrix_task_scrum_info): ${errorMessage(e)}`);
        });
        if (after.entityId !== backlogId) throw new Error(`Bitrix ответил успехом, но задача не в бэклоге (сейчас в ${after.entityId})`);
        return { backlogId, ...(await leaveSprintColumn(ctx, taskId, stages.start)), changed: true };
      });
    },
  }),
  defineOperation({
    name: "task_create",
    description:
      "⚠ МУТИРУЮЩИЙ. Создать задачу в scrum-проекте groupId сразу на доске АКТИВНОГО спринта — как кнопкой «+» " +
      "на доске. title — название, простой текст (BBCode в названии не работает). column — id колонки или её " +
      `название (без учёта регистра); без него — колонка типа NEW; список — bitrix_sprint_columns. ${NO_FINISH_COLUMN} Задача ` +
      "создаётся от твоего имени, её видят все участники проекта; остальные поля — по умолчанию Bitrix, " +
      "задавай их потом отдельными операциями (bitrix_task_description_set, bitrix_task_delegate, " +
      "bitrix_task_accomplices, bitrix_task_auditors, …). Ответ: { taskId, sprintId, stageId, column }.",
    mutating: true,
    // Four requests in a row.
    budget: "long",
    input: { groupId: idArg(), title: z.string().trim().min(1).max(TITLE_MAX), column: columnArg().optional() },
    run: async (ctx, a) => {
      const { sprintId, columns } = await activeSprintColumns(ctx, a.groupId);
      const target = targetColumn(columns, a.column);
      refuseClosingColumns([target]);
      const userId = await currentUserId(ctx);
      const creating = ctx.call({
        ...BOARD_CREATE,
        params: {
          taskName: a.title,
          columnId: target.id,
          parentTaskId: 0,
          beforeItemId: 0,
          params: {
            USER_ID: userId,
            GROUP_ID: a.groupId,
            GROUP_ID_FORCED: 0,
            SPRINT_ID: sprintId,
            IS_COMPLETED_SPRINT: "N",
            PERSONAL: "N",
            TIMELINE_MODE: "N",
          },
          personal: "N",
        },
      });
      const created = (await mayHaveHappened(creating, boardCreateResponse, "bitrix:tasks.kanban addTask", CREATE_MAY_EXIST)).data;
      if (created.columnId != null && created.columnId !== target.id) {
        throw new Error(`задача ${created.id} создана, но в колонке ${created.columnId}, а не «${target.name}» (${target.id})`);
      }
      return { taskId: created.id, sprintId, stageId: target.id, column: target.name };
    },
  }),
  defineOperation({
    name: "task_result_add",
    description:
      "⚠ МУТИРУЮЩИЙ. Добавить один и тот же РЕЗУЛЬТАТ задачам (taskIds — до 50): он закрепляется в " +
      "карточке каждой задачи и объявляется в её чате (его видят все участники). Формат — BBCode, как в " +
      `описании задачи (как он выглядит в карточке в чате, не проверено). До ${RESULT_MAX} символов. ` +
      "Задачи обрабатываются по очереди; ошибка одной не останавливает остальные. " +
      "Ответ: { results: [{ taskId, ok, error?, resultId }] }.",
    mutating: true,
    budget: "long",
    input: { taskIds: taskIdsArg(), text: z.string().min(1).max(RESULT_MAX) },
    run: (ctx, a) =>
      forEachTask(a.taskIds, async (taskId) => {
        const write = ctx.call({ ...RESULT_ADD, params: { results: [{ taskId, text: a.text }] } });
        return { resultId: (await mayHaveHappened(write, resultAddResponse, "tasks.v2.Task.Result.add", RESULT_MAY_EXIST)).data[0].id };
      }),
  }),
  defineOperation({
    name: "task_delegate",
    description:
      "⚠ МУТИРУЮЩИЙ. Делегировать задачи (taskIds — до 50) другому человеку: userId становится " +
      "ответственным и получает уведомление; смена видна в истории задачи. Если он уже соисполнитель, " +
      "там он и остаётся. Задачи обрабатываются по очереди; ошибка одной не останавливает остальные. " +
      "Ответ: { results: [{ taskId, ok, error?, responsibleId }] } — responsibleId перечитан после делегирования.",
    mutating: true,
    budget: "long",
    input: { taskIds: taskIdsArg(), userId: idArg() },
    run: (ctx, a) =>
      forEachTask(a.taskIds, async (taskId) => {
        await ctx.call({ ...TASK_DELEGATE, params: { taskId, userId: a.userId } });
        const { responsibleId } = await readResponsible(ctx, taskId).catch((e: unknown) => {
          throw new Error(`делегирование отправлено, но перечитать задачу не удалось (проверь ответственного через bitrix_task_get): ${errorMessage(e)}`);
        });
        if (responsibleId !== a.userId) throw new Error(`Bitrix ответил успехом, но ответственный не сменился (сейчас ${responsibleId})`);
        return { responsibleId };
      }),
  }),
  memberListOperation({
    name: "task_accomplices",
    field: "ACCOMPLICES",
    key: "accomplices",
    description:
      "⚠ МУТИРУЮЩИЙ. Добавить / убрать СОИСПОЛНИТЕЛЕЙ задач (taskIds — до 50). Каждый добавленный " +
      "получает уведомление; правка видна в истории задачи. " +
      MEMBERS_HINT +
      " Ответ: { results: [{ taskId, ok, error?, accomplices, changed }] } — accomplices — список, перечитанный после записи.",
  }),
  memberListOperation({
    name: "task_auditors",
    field: "AUDITORS",
    key: "auditors",
    description:
      "⚠ МУТИРУЮЩИЙ. Добавить / убрать НАБЛЮДАТЕЛЕЙ задач (taskIds — до 50). Каждый добавленный " +
      "получает уведомление; правка видна в истории задачи. " +
      MEMBERS_HINT +
      " Ответ: { results: [{ taskId, ok, error?, auditors, changed }] } — auditors — список, перечитанный после записи.",
  }),
  defineOperation({
    name: "user_find",
    description:
      "Найти пользователей портала по фамилии (read-only): [{ id, name, lastName, active, workPosition }]. " +
      "В выдаче есть и НЕАКТИВНЫЕ (уволенные) — active: false; не назначай их на рабочие задачи, но для " +
      "безопасной проверки мутирующих операций (соисполнители, наблюдатели, делегирование) они удобны — " +
      "уведомление никто не прочтёт.",
    mutating: false,
    input: { lastName: z.string().trim().min(1).max(100) },
    run: async (ctx, a) => {
      const raw = await ctx.call({ ...USER_GET, params: { FILTER: { LAST_NAME: a.lastName } } });
      return parseResponse(usersResponse, raw, "user.get").result.map((u) => ({
        id: u.ID,
        name: u.NAME,
        lastName: u.LAST_NAME,
        active: u.ACTIVE,
        workPosition: u.WORK_POSITION,
      }));
    },
  }),
];
