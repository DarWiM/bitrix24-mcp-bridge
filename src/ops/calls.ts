// Request targets and answer parsing shared by the modules that write to the portal.

import { z } from "zod";
import { callTarget } from "./read.js";

export const restMethod = (method: string) => callTarget({ endpoint: `/rest/${method}.json`, method: "POST" });

// read.ts has an ajax TASK_GET of its own.
export const REST_TASK_GET = restMethod("tasks.task.get");

// Classic REST hands ids and statuses back as strings.
export const numeric = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number);

export function parseResponse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, method: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${method} returned an unexpected shape`);
  return parsed.data;
}
