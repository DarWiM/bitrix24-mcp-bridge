// Accumulates unique parameter combinations per action for actions.draft.json.
// Dedup is by a recursive, key-sorted fingerprint so identical sets collapse regardless
// of field order. Fingerprints are held in `seen` (aside from the entries) so this
// bookkeeping never leaks into the serialized JSON.

export interface DraftEntry {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  transport: "ajax" | "rest" | "other";
  bodyType: "json" | "form";
  sampleParams: Record<string, unknown>[];
}

export interface SampleMeta {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  transport: "ajax" | "rest" | "other";
  bodyType: "json" | "form";
}

export interface DraftAccumulator {
  entries: Map<string, DraftEntry>;
  seen: Map<string, Set<string>>;
}

export function newAccumulator(): DraftAccumulator {
  return { entries: new Map(), seen: new Map() };
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return "{" + Object.keys(obj).sort()
    .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
    .join(",") + "}";
}

export function fingerprint(params: Record<string, unknown>): string {
  return stableStringify(params);
}

export type AddResult = "new-action" | "new-variant" | "duplicate";

export function addSample(
  acc: DraftAccumulator,
  meta: SampleMeta,
  params: Record<string, unknown>,
): AddResult {
  const key = meta.action ?? meta.endpoint;
  let entry = acc.entries.get(key);
  let result: AddResult;
  if (!entry) {
    entry = {
      endpoint: meta.endpoint,
      action: meta.action,
      method: meta.method,
      transport: meta.transport,
      bodyType: meta.bodyType,
      sampleParams: [],
    };
    acc.entries.set(key, entry);
    acc.seen.set(key, new Set());
    result = "new-action";
  } else {
    if (entry.bodyType !== meta.bodyType) {
      console.error(`⚠ ${key}: mixed bodyType (${entry.bodyType} vs ${meta.bodyType}) — keeping ${entry.bodyType}`);
    }
    result = "new-variant";
  }
  const fp = fingerprint(params);
  const seen = acc.seen.get(key)!;
  if (seen.has(fp)) return "duplicate";
  seen.add(fp);
  entry.sampleParams.push(params);
  return result;
}

export function toObject(acc: DraftAccumulator): Record<string, DraftEntry> {
  return Object.fromEntries(acc.entries);
}
