// The scrum board as the operations see it: the active sprint and its columns, where a task sits
// (backlog / sprint, column) and moving it between columns.

import { z } from "zod";
import { errorMessage } from "./batch.js";
import { REST_TASK_GET, numeric, parseResponse, restMethod } from "./calls.js";
import { OpInputError, type OpContext } from "./operation.js";

const SPRINT_LIST = restMethod("tasks.api.scrum.sprint.list");
const SPRINT_STAGES = restMethod("tasks.api.scrum.kanban.getStages");
const STAGE_MOVE = restMethod("task.stages.movetask");
const SCRUM_TASK_GET = restMethod("tasks.api.scrum.task.get");
const BACKLOG_GET = restMethod("tasks.api.scrum.backlog.get");
// The project's own (non-scrum) kanban, not the sprint board.
const GROUP_STAGES = restMethod("task.stages.get");
const USER_CURRENT = restMethod("user.current");

const TASK_STAGE_SELECT = ["ID", "GROUP_ID", "STAGE_ID", "STATUS"];

const sprintsResponse = z.object({ result: z.array(z.object({ id: numeric, status: z.string() })) });
const stagesResponse = z.object({
  result: z.array(z.object({ id: numeric, name: z.string(), type: z.string().nullish(), sort: numeric })),
});
const taskResponse = z.object({
  result: z.object({ task: z.object({ groupId: numeric.nullish(), stageId: numeric.nullish(), status: numeric.nullish() }) }),
});
const scrumTaskResponse = z.object({ result: z.object({ entityId: numeric, groupId: numeric.nullish() }) });
const backlogResponse = z.object({ result: z.object({ id: numeric }) });
const currentUserResponse = z.object({ result: z.object({ ID: numeric }) });
const groupStage = z.object({ ID: numeric, TITLE: z.string(), SYSTEM_TYPE: z.string().nullish() });
// Keyed by stage id; PHP sends an empty map as [].
const groupStagesResponse = z.object({ result: z.union([z.record(groupStage), z.array(groupStage)]) });

export interface SprintColumn {
  id: number;
  name: string;
  type: string;
}

export async function activeSprintColumns(ctx: OpContext, groupId: number): Promise<{ sprintId: number; columns: SprintColumn[] }> {
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

export async function readTaskStage(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...REST_TASK_GET, params: { taskId, select: TASK_STAGE_SELECT } });
  return parseResponse(taskResponse, raw, "tasks.task.get").result.task;
}

// The request below goes out at most once per operation call, whichever helper asks first.
const currentUsers = new WeakMap<OpContext, Promise<number>>();

export function currentUserId(ctx: OpContext): Promise<number> {
  let lookup = currentUsers.get(ctx);
  if (!lookup) {
    lookup = ctx.call(USER_CURRENT).then((raw) => parseResponse(currentUserResponse, raw, "user.current").result.ID);
    currentUsers.set(ctx, lookup);
  }
  return lookup;
}

// A batch usually touches tasks of one project: what is looked up per project, is looked up once.
export function perGroup<T>(load: (groupId: number) => Promise<T>): (groupId: number) => Promise<T> {
  const cache = new Map<number, Promise<T>>();
  return (groupId) => {
    let found = cache.get(groupId);
    if (!found) {
      found = load(groupId);
      cache.set(groupId, found);
    }
    return found;
  };
}

export async function readScrumTask(ctx: OpContext, taskId: number) {
  const raw = await ctx.call({ ...SCRUM_TASK_GET, params: { id: taskId } });
  const { entityId, groupId } = parseResponse(scrumTaskResponse, raw, "tasks.api.scrum.task.get").result;
  if (!groupId) throw new Error(`задача ${taskId} не в scrum-проекте — бэклог и спринты есть только у задач scrum-проекта`);
  return { entityId, groupId };
}

export async function readBacklogId(ctx: OpContext, groupId: number) {
  const raw = await ctx.call({ ...BACKLOG_GET, params: { id: groupId } });
  return parseResponse(backlogResponse, raw, "tasks.api.scrum.backlog.get").result.id;
}

// A task outside every sprint sits in a stage of the project's own kanban: the UI puts a task dragged
// into the backlog into its NEW stage. A STAGE_ID outside these stages is a sprint column, and the
// sprint board keeps showing the task there.
export async function readGroupStages(ctx: OpContext, groupId: number) {
  const raw = await ctx.call({ ...GROUP_STAGES, params: { entityId: groupId } });
  const stages = Object.values(parseResponse(groupStagesResponse, raw, "task.stages.get").result);
  const start = stages.find((s) => s.SYSTEM_TYPE === "NEW");
  if (!start) throw new Error(`у проекта ${groupId} нет стартовой стадии (SYSTEM_TYPE NEW) в task.stages.get — ничего не изменено`);
  return { ids: new Set(stages.map((s) => s.ID)), start: { id: start.ID, name: start.TITLE } };
}

function findColumn(columns: SprintColumn[], column: number | string): SprintColumn | undefined {
  if (typeof column === "number") return columns.find((c) => c.id === column);
  const wanted = column.trim().toLowerCase();
  const byName = columns.find((c) => c.name.trim().toLowerCase() === wanted);
  // Agents often pass an id as a string; a column literally named "61" still wins above.
  return byName ?? (/^\d+$/.test(wanted) ? columns.find((c) => c.id === Number(wanted)) : undefined);
}

// No column → the board's NEW-type column, where the UI puts a new task too.
export function targetColumn(columns: SprintColumn[], column: number | string | undefined): SprintColumn {
  const target = column === undefined ? columns.find((c) => c.type === "NEW") : findColumn(columns, column);
  if (target) return target;
  const available = columns.map((c) => `«${c.name}» (${c.id})`).join(", ");
  if (column === undefined) throw new Error(`на доске активного спринта нет колонки типа NEW — укажи column; есть: ${available}`);
  throw new Error(`колонки ${JSON.stringify(column)} нет на доске активного спринта; есть: ${available}`);
}

// Bitrix completes a task put into a FINISH column, and Definition of Done is asked for only by the web
// UI's popup on that move: no operation puts a task there, closing goes through task_close.
// A batch's column name may resolve to a FINISH column in just one of its projects, so the whole call
// is refused before any write; writers check again right before their own write.
export function refuseClosingColumns(targets: SprintColumn[]) {
  const closing = targets.find((c) => c.type.toUpperCase() === "FINISH");
  if (closing) {
    throw new OpInputError(
      `колонка «${closing.name}» (${closing.id}) завершает задачу — закрыть задачу можно только через bitrix_task_close ` +
        "(там проверяется Definition of Done); ничего не изменено",
    );
  }
}

// `recovery` is appended when the task did not move: what the caller can do about it depends on
// how the task got onto the board.
export async function moveToColumn(ctx: OpContext, taskId: number, target: SprintColumn, recovery?: string) {
  refuseClosingColumns([target]);
  await ctx.call({ ...STAGE_MOVE, params: { id: taskId, stageId: target.id } });
  const moved = await readTaskStage(ctx, taskId).catch((e: unknown) => {
    throw new Error(`перенос отправлен, но перечитать задачу не удалось (проверь её колонку через bitrix_task_get): ${errorMessage(e)}`);
  });
  // movetask answers true and does nothing for a task that is not on the sprint board.
  if (moved.stageId !== target.id) {
    const notMoved = "Bitrix ответил true, но задача не переехала — вероятно, её нет на доске спринта";
    throw new Error(recovery ? `${notMoved}; ${recovery}` : notMoved);
  }
  return { stageId: target.id, column: target.name, status: moved.status ?? null };
}

// A factory for the same `$ref` reason as idArg.
export const columnArg = () => z.union([z.number().int().positive(), z.string().min(1)]);
