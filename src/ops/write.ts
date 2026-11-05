// Operations that change task content, post messages or move tasks on the scrum board.
// None of them takes agent `params`: merged-in fields could widen a write beyond what the tool
// says it does.

import { z } from "zod";
import { forEachTask, taskIdsArg } from "./batch.js";
import { OpInputError, defineOperation, idArg, type OpContext, type Operation } from "./operation.js";
import { TASK_V2_GET, callTarget } from "./read.js";

const restMethod = (method: string) => callTarget({ endpoint: `/rest/${method}.json`, method: "POST" });

const TASK_UPDATE = restMethod("tasks.task.update");
// read.ts has an ajax TASK_GET of its own.
const REST_TASK_GET = restMethod("tasks.task.get");
const MESSAGE_ADD = restMethod("im.message.add");
const SPRINT_LIST = restMethod("tasks.api.scrum.sprint.list");
const SPRINT_STAGES = restMethod("tasks.api.scrum.kanban.getStages");
const STAGE_MOVE = restMethod("task.stages.movetask");
// The official tasks.task.result.add exists in REST 3.0 only, which the session refuses.
const RESULT_ADD = callTarget({ action: "tasks.v2.Task.Result.add", method: "POST", bodyType: "json" });

const TASK_STAGE_SELECT = ["ID", "GROUP_ID", "STAGE_ID", "STATUS"];

const DESCRIPTION_MAX = 100_000;
// Bitrix's documented message limit; past it the portal truncates without an error.
const MESSAGE_MAX = 20_000;
const RESULT_MAX = 20_000;

// Classic REST hands ids and statuses back as strings.
const numeric = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number);

// `description` is required, not optional: reading an unexpected shape as "empty" would make
// append overwrite the whole description with the new text.
const descriptionResponse = z.object({ data: z.object({ description: z.string().nullable() }) });
const messageResponse = z.object({ result: numeric });
const sprintsResponse = z.object({ result: z.array(z.object({ id: numeric, status: z.string() })) });
const stagesResponse = z.object({
  result: z.array(z.object({ id: numeric, name: z.string(), type: z.string().nullish(), sort: numeric })),
});
const taskResponse = z.object({
  result: z.object({ task: z.object({ groupId: numeric.nullish(), stageId: numeric.nullish(), status: numeric.nullish() }) }),
});
const resultAddResponse = z.object({ data: z.array(z.object({ id: numeric })).min(1) });

function parseResponse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, method: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${method} returned an unexpected shape`);
  return parsed.data;
}

async function writeDescription(ctx: OpContext, taskId: number, text: string) {
  await ctx.call({ ...TASK_UPDATE, params: { taskId, fields: { DESCRIPTION: text } } });
  return { taskId, length: text.length };
}

interface SprintColumn {
  id: number;
  name: string;
  type: string;
}

async function activeSprintColumns(ctx: OpContext, groupId: number): Promise<{ sprintId: number; columns: SprintColumn[] }> {
  const sprints = parseResponse(
    sprintsResponse,
    await ctx.call({ ...SPRINT_LIST, params: { filter: { GROUP_ID: groupId, STATUS: "active" } } }),
    "tasks.api.scrum.sprint.list",
  );
  // Checked again here: were the filter ignored, the first sprint could be a finished one.
  const sprint = sprints.result.find((s) => s.status === "active");
  if (!sprint) throw new Error(`в проекте ${groupId} нет активного спринта — сначала начните спринт на scrum-доске (или это не scrum-проект)`);
  const stages = parseResponse(
    stagesResponse,
    await ctx.call({ ...SPRINT_STAGES, params: { sprintId: sprint.id } }),
    "tasks.api.scrum.kanban.getStages",
  );
  const columns = [...stages.result]
    .sort((a, b) => a.sort - b.sort)
    .map(({ id, name, type }) => ({ id, name, type: type ?? "" }));
  return { sprintId: sprint.id, columns };
}

async function readTaskStage(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REST_TASK_GET, params: { taskId, select: TASK_STAGE_SELECT } });
  return parseResponse(taskResponse, raw, "tasks.task.get").result.task;
}

function findColumn(columns: SprintColumn[], column: number | string): SprintColumn | undefined {
  if (typeof column === "number") return columns.find((c) => c.id === column);
  const wanted = column.trim().toLowerCase();
  const byName = columns.find((c) => c.name.trim().toLowerCase() === wanted);
  // Agents often pass an id as a string; a column literally named "61" still wins above.
  return byName ?? (/^\d+$/.test(wanted) ? columns.find((c) => c.id === Number(wanted)) : undefined);
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
  defineOperation({
    name: "sprint_columns",
    description:
      "Колонки доски АКТИВНОГО спринта scrum-проекта (read-only), по порядку на доске: " +
      "{ groupId, sprintId, columns: [{ id, name, type }] }. groupId — id проекта (GROUP_ID задачи). " +
      "type — NEW / WORK / FINISH; у пользовательских колонок (напр. «Testing») type пустой. " +
      "Не путать с task.stages.get: тот отдаёт старый канбан группы, а не колонки спринта.",
    mutating: false,
    input: { groupId: idArg() },
    run: async (ctx, a) => ({ groupId: a.groupId, ...(await activeSprintColumns(ctx, a.groupId)) }),
  }),
  defineOperation({
    name: "task_move",
    description:
      "⚠ МУТИРУЮЩИЙ. Перенести задачи (taskIds — до 50) в колонку доски активного спринта их проекта. " +
      "column — id колонки или её название (без учёта регистра); список колонок — bitrix_sprint_columns. " +
      "Работает только для задач, которые уже на доске спринта (не в бэклоге). Перенос может " +
      "переоткрыть закрытую задачу — смотри status в ответе. Задачи переносятся по очереди; ошибка одной " +
      "не останавливает остальные. Ответ: { results: [{ taskId, ok, error?, stageId, column, status }] }.",
    mutating: true,
    // Up to five requests per task.
    budget: "long",
    input: { taskIds: taskIdsArg(), column: z.union([z.number().int().positive(), z.string().min(1)]) },
    run: async (ctx, a) => {
      // A hand-off usually moves tasks of one project: its columns are looked up once per batch.
      const columnsByGroup = new Map<number, Promise<SprintColumn[]>>();
      return forEachTask(a.taskIds, async (taskId) => {
        const task = await readTaskStage(ctx, taskId);
        if (!task.groupId) throw new Error(`задача ${taskId} не в проекте — колонки спринта есть только у задач scrum-проекта`);
        let columnsLookup = columnsByGroup.get(task.groupId);
        if (!columnsLookup) {
          columnsLookup = activeSprintColumns(ctx, task.groupId).then((s) => s.columns);
          columnsByGroup.set(task.groupId, columnsLookup);
        }
        const columns = await columnsLookup;
        const target = findColumn(columns, a.column);
        if (!target) {
          throw new Error(
            `колонки ${JSON.stringify(a.column)} нет на доске активного спринта; есть: ${columns.map((c) => `«${c.name}» (${c.id})`).join(", ")}`,
          );
        }
        await ctx.call({ ...STAGE_MOVE, params: { id: taskId, stageId: target.id } });
        const moved = await readTaskStage(ctx, taskId).catch(() => {
          throw new Error("перенос отправлен, но перечитать задачу не удалось — проверь её колонку через bitrix_task_get");
        });
        // movetask answers true and does nothing for a task that is not on the sprint board.
        if (moved.stageId !== target.id) {
          throw new Error("Bitrix ответил true, но задача не переехала — вероятно, её нет на доске спринта");
        }
        return { stageId: target.id, column: target.name, status: moved.status ?? null };
      });
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
        const raw = await ctx.call({ ...RESULT_ADD, params: { results: [{ taskId, text: a.text }] } });
        return { resultId: parseResponse(resultAddResponse, raw, "tasks.v2.Task.Result.add").data[0].id };
      }),
  }),
];
