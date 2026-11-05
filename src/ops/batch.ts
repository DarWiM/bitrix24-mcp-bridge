// Running one mutation over a list of tasks: the agent gets a verdict per task instead of an
// aggregate, so a partly failed hand-off is never reported as a success.

import { z } from "zod";
import { idArg } from "./operation.js";

export const MAX_BATCH = 50;

// A factory for the same `$ref` reason as idArg.
export const taskIdsArg = () => z.array(idArg()).min(1).max(MAX_BATCH);

export type TaskOutcome<T extends object> = ({ taskId: number; ok: true } & T) | { taskId: number; ok: false; error: string };

export interface BatchResult<T extends object> {
  results: TaskOutcome<T>[];
}

// Sequential on purpose: the side effects (chat announcements, notifications) then happen in the
// order the agent asked for, and the portal sees one request of the session at a time.
export async function forEachTask<T extends object>(taskIds: number[], fn: (taskId: number) => Promise<T>): Promise<BatchResult<T>> {
  const results: TaskOutcome<T>[] = [];
  for (const taskId of taskIds) {
    try {
      results.push({ taskId, ok: true, ...(await fn(taskId)) });
    } catch (e) {
      results.push({ taskId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results };
}
