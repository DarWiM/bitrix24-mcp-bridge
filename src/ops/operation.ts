import { z } from "zod";
import type { CallTarget, DownloadResult } from "../../shared/wire.js";

export interface OpContext {
  portal: string;
  origin: string;
  // alias → origin of every configured portal: a portal-minted link may belong to another portal.
  origins: Record<string, string>;
  downloadsDir: string;
  // `portal` sends this one request to another configured portal instead of ctx.portal.
  call(target: CallTarget, portal?: string): Promise<unknown>;
  callBinary(target: CallTarget, destPath: string, portal?: string): Promise<DownloadResult>;
}

// How long the MCP client waits for the daemon's answer. "long" covers operations that chain many
// portal requests, each allowed up to the daemon's own per-request timeout.
export type OpBudget = "call" | "download" | "long";

export interface Operation {
  name: string;
  description: string;
  mutating: boolean;
  budget: OpBudget;
  input: z.ZodRawShape;
  execute(ctx: OpContext, rawArgs: unknown): Promise<unknown>;
}

export class OpInputError extends Error {}
export class OpRefusedError extends Error {}

// Digits only: ids also end up in file names, so anything path-like must not get through.
// A factory, because zod-to-json-schema turns a schema instance reused within one input into a
// `$ref` to the first field, and tool schemas should stay plain.
export const idArg = () => z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(Number);

// ajax.php picks the controller from `action` / `c` / `mode` and the CSRF token from `sessid`, and
// PHP may read them from the body as well as the query. An agent's `params` land in the body after
// the operation's own fields, so these keys must not come from there: a read could turn into any
// other call. The base of a bracketed key counts too: PHP reads `action[0]` as `action`.
const RESERVED_PARAM_KEYS = new Set(["action", "c", "mode", "sessid"]);

// The Bitrix-native `params` object an operation lets the agent merge into its request.
// A factory for the same `$ref` reason as idArg.
export const agentParams = () =>
  z
    .record(z.unknown())
    .superRefine((value, ctx) => {
      for (const key of Object.keys(value)) {
        if (RESERVED_PARAM_KEYS.has(key.split("[")[0])) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${key}" is fixed by the operation and cannot be set through params` });
        }
      }
    })
    .optional();

export function defineOperation<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  mutating: boolean;
  budget?: OpBudget;
  input: S;
  run(ctx: OpContext, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}): Operation {
  const schema = z.object(def.input);
  return {
    name: def.name,
    description: def.description,
    mutating: def.mutating,
    budget: def.budget ?? "call",
    input: def.input,
    async execute(ctx, rawArgs) {
      const parsed = schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const fields = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(args)"}: ${issue.message}`)
          .join("; ");
        throw new OpInputError(`invalid arguments for ${def.name} — ${fields}`);
      }
      return def.run(ctx, parsed.data);
    },
  };
}
