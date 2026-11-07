// Request targets and answer parsing shared by the modules that write to the portal.

import { z } from "zod";
import { errorMessage } from "./batch.js";
import { callTarget, v2 } from "./read.js";

export const restMethod = (method: string) => callTarget({ endpoint: `/rest/${method}.json`, method: "POST" });
// Defined next to callTarget: read.ts needs it too, and importing it from here would be a cycle.
export { v2 };

// read.ts has an ajax TASK_GET of its own.
export const REST_TASK_GET = restMethod("tasks.task.get");

// Classic REST hands ids and statuses back as strings.
export const numeric = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number);

export function parseResponse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, method: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${method} returned an unexpected shape`);
  return parsed.data;
}

// What the task readers answer for a deleted task and for one the user cannot see alike:
// REST and ajax `tasks.task.get` an empty array, `tasks.v2.Task.get` null.
const noTaskResponse = z.union([z.object({ result: z.tuple([]) }), z.object({ data: z.union([z.null(), z.tuple([])]) })]);

export function parseTaskCard<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, method: string, taskId: number): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (noTaskResponse.safeParse(raw).success) throw new Error(`задача ${taskId} не найдена или нет доступа (удалена или скрыта от тебя)`);
  throw new Error(`${method} returned an unexpected shape`);
}

// Neither a timeout, a lost extension nor an unrecognised answer means the portal did not do the
// write: `unconfirmed` says what may have happened and what to check, so that a blind retry does not
// do it twice.
export async function mayHaveHappened<T>(
  write: Promise<unknown>,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  method: string,
  unconfirmed: string,
): Promise<T> {
  const raw = await write.catch((e: unknown) => {
    throw new Error(`${errorMessage(e)} — ${unconfirmed}`);
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${method} returned an unexpected shape — ${unconfirmed}`);
  return parsed.data;
}

// The write went out: a failed re-read must not read as a failed write.
export const reread = <T>(read: Promise<T>, checkWith: string) =>
  read.catch((e: unknown) => {
    throw new Error(`запись отправлена, но перечитать не удалось (проверь через ${checkWith}): ${errorMessage(e)}`);
  });
