// Running one mutation over a list of tasks: the agent gets a verdict per task instead of an
// aggregate, so a partly failed hand-off is never reported as a success.

import { z } from "zod";
import { BUDGET_TIMEOUT_MS, idArg } from "./operation.js";

export const MAX_BATCH = 50;

// Room for the task already running when the batch stops starting new ones: about one portal
// request at the daemon's 30 s timeout.
const BATCH_RESERVE_MS = 30_000;
const SKIPPED = "не выполнено: истекло время пакета — перечитайте состояние и повторите только эти задачи";

// A factory for the same `$ref` reason as idArg. Duplicates are refused: the same task twice
// would get two results or two notifications. Checked after the transform, so 42 and "42" clash.
export const taskIdsArg = () =>
  z
    .array(idArg())
    .min(1)
    .max(MAX_BATCH)
    .superRefine((ids, ctx) => {
      const seen = new Set<number>();
      for (const id of ids) {
        if (seen.has(id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `task ${id} is listed more than once` });
          return;
        }
        seen.add(id);
      }
    });

export type TaskOutcome<T extends object> = ({ taskId: number; ok: true } & T) | { taskId: number; ok: false; error: string };

export interface BatchResult<T extends object> {
  results: TaskOutcome<T>[];
}

export interface BatchOptions {
  // What the client waits for the whole operation; the batch is meant to run under a "long" budget.
  budgetMs?: number;
  now?: () => number;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Sequential on purpose: the side effects (chat announcements, notifications) then happen in the
// order the agent asked for, and the portal sees one request of the session at a time.
// Past the client's timeout the agent would see no results at all, so tasks that cannot fit are
// reported as not done rather than started.
export async function forEachTask<T extends object>(
  taskIds: number[],
  fn: (taskId: number) => Promise<T>,
  { budgetMs = BUDGET_TIMEOUT_MS.long, now = Date.now }: BatchOptions = {},
): Promise<BatchResult<T>> {
  const startBefore = now() + budgetMs - BATCH_RESERVE_MS;
  const results: TaskOutcome<T>[] = [];
  for (const taskId of taskIds) {
    if (now() >= startBefore) {
      results.push({ taskId, ok: false, error: SKIPPED });
      continue;
    }
    try {
      const fields = await fn(taskId);
      const verdict = { taskId, ok: true as const };
      // Spread twice: first for the key order, last so the operation's fields cannot overwrite it.
      results.push({ ...verdict, ...fields, ...verdict });
    } catch (e) {
      results.push({ taskId, ok: false, error: errorMessage(e) });
    }
  }
  return { results };
}
