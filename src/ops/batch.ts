// Running one mutation over a list of tasks: the agent gets a verdict per task instead of an
// aggregate, so a partly failed hand-off is never reported as a success.

import { z } from "zod";
import { BUDGET_TIMEOUT_MS, idArg } from "./operation.js";

export const MAX_BATCH = 50;

// Room for the step already running when a call stops starting new ones: at least one portal
// request at the daemon's 30 s timeout, more once a step of this call has taken longer.
const STEP_RESERVE_MS = 30_000;
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

// Paces the steps of one call against what the client waits for it. The slowest step so far is the
// best guess for the next one, so steps that take several requests each stop early enough too.
export function budgetPace({ budgetMs = BUDGET_TIMEOUT_MS.long, now = Date.now }: BatchOptions = {}) {
  const deadline = now() + budgetMs;
  let longestMs = 0;
  return {
    // `thenRequests`: requests the call still makes after the step, each given a full reserve.
    canStart: (thenRequests = 0) => now() + Math.max(STEP_RESERVE_MS, longestMs) + thenRequests * STEP_RESERVE_MS < deadline,
    async time<R>(step: () => Promise<R>): Promise<R> {
      const startedAt = now();
      try {
        return await step();
      } finally {
        longestMs = Math.max(longestMs, now() - startedAt);
      }
    },
  };
}

type Pace = ReturnType<typeof budgetPace>;

// Sequential on purpose: the side effects (chat announcements, notifications) then happen in the
// order the agent asked for, and the portal sees one request of the session at a time.
// Past the client's timeout the agent would see no results at all, so tasks that cannot fit are
// reported as not done rather than started.
export async function forEachTask<T extends object>(
  taskIds: number[],
  fn: (taskId: number) => Promise<T>,
  opts: BatchOptions = {},
): Promise<BatchResult<T>> {
  return eachTask(taskIds, fn, budgetPace(opts));
}

async function eachTask<T extends object>(taskIds: number[], fn: (taskId: number) => Promise<T>, pace: Pace): Promise<BatchResult<T>> {
  const results: TaskOutcome<T>[] = [];
  for (const taskId of taskIds) {
    if (!pace.canStart()) {
      results.push({ taskId, ok: false, error: SKIPPED });
      continue;
    }
    try {
      const fields = await pace.time(() => fn(taskId));
      const verdict = { taskId, ok: true as const };
      // Spread twice: first for the key order, last so the operation's fields cannot overwrite it.
      results.push({ ...verdict, ...fields, ...verdict });
    } catch (e) {
      results.push({ taskId, ok: false, error: errorMessage(e) });
    }
  }
  return { results };
}

// Two passes: the reads of every task first, so that the caller can refuse the whole call on what
// they found before any task is touched; then the writes, in what the reads left of the budget.
// A task the first pass failed keeps that error.
export async function forEachTaskVetted<P, T extends object>(
  taskIds: number[],
  steps: {
    prepare: (taskId: number) => Promise<P>;
    vet: (prepared: P[]) => void;
    apply: (taskId: number, prepared: P) => Promise<T>;
  },
  opts: BatchOptions = {},
): Promise<BatchResult<T>> {
  // One pace for both passes: the slowest read is a floor for the room a write needs.
  const pace = budgetPace(opts);
  const { results } = await eachTask(taskIds, async (taskId) => ({ prepared: await steps.prepare(taskId) }), pace);
  steps.vet(results.flatMap((r) => (r.ok ? [r.prepared] : [])));
  const firstPass = new Map(results.map((r) => [r.taskId, r]));
  // Only the tasks that would actually start are paced: a failed read keeps its own error even when
  // time is up.
  const ready = results.flatMap((r) => (r.ok ? [r.taskId] : []));
  const secondPass = await eachTask(
    ready,
    async (taskId) => {
      const first = firstPass.get(taskId);
      if (!first?.ok) throw new Error(first?.error ?? SKIPPED);
      return steps.apply(taskId, first.prepared);
    },
    pace,
  );
  const applied = new Map(secondPass.results.map((r) => [r.taskId, r]));
  return {
    results: results.map((first) => (first.ok ? (applied.get(first.taskId) ?? { taskId: first.taskId, ok: false, error: SKIPPED }) : first)),
  };
}
