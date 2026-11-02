import { OpRefusedError, type OpContext, type Operation } from "./operation.js";

export interface Registry {
  get(name: string): Operation | undefined;
  list(): Operation[];
}

export function createRegistry(ops: Operation[]): Registry {
  const byName = new Map<string, Operation>();
  for (const op of ops) {
    if (byName.has(op.name)) throw new Error(`duplicate operation name: ${op.name}`);
    byName.set(op.name, op);
  }
  return {
    get: (name) => byName.get(name),
    list: () => [...byName.values()],
  };
}

export async function runOperation(
  reg: Registry,
  name: string,
  rawArgs: unknown,
  ctx: OpContext,
  policy: { allowMutations: boolean },
): Promise<unknown> {
  const op = reg.get(name);
  if (!op) throw new OpRefusedError(`unknown operation ${JSON.stringify(name)}`);
  if (op.mutating && !policy.allowMutations) {
    throw new OpRefusedError(
      `operation ${name} changes data, but mutations are disabled; enable them in config.json to allow it`,
    );
  }
  return op.execute(ctx, rawArgs);
}
