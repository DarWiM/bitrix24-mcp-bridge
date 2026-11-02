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

export interface Operation {
  name: string;
  description: string;
  mutating: boolean;
  input: z.ZodRawShape;
  execute(ctx: OpContext, rawArgs: unknown): Promise<unknown>;
}

export class OpInputError extends Error {}
export class OpRefusedError extends Error {}

// Digits only: ids also end up in file names, so anything path-like must not get through.
// A factory, because zod-to-json-schema turns a schema instance reused within one input into a
// `$ref` to the first field, and tool schemas should stay plain.
export const idArg = () => z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(Number);

export function defineOperation<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  mutating: boolean;
  input: S;
  run(ctx: OpContext, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}): Operation {
  const schema = z.object(def.input);
  return {
    name: def.name,
    description: def.description,
    mutating: def.mutating,
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
