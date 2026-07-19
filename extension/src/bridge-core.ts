// Pure, browser-agnostic — unit-tested.

// Wire types come from the shared single source; re-exported so downstream
// extension modules keep importing them from here.
import type { CallRequest } from "../../shared/wire.ts";
export type { CallRequest, CapturedEntry } from "../../shared/wire.ts";

// Extension-only: the shape handleCall returns to the bridge (not a wire message).
export interface InterpretResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function encodeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const add = (key: string, val: unknown): void => {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) val.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof val === "object") for (const [k, v] of Object.entries(val)) add(`${key}[${k}]`, v);
    else out.set(key, String(val));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.toString();
}

export function buildRequest(
  origin: string,
  req: CallRequest,
  sessid: string,
): { url: string; body: string; contentType: string } {
  const q = req.action ? `?action=${encodeURIComponent(req.action)}` : "";
  const url = `${origin}${req.endpoint}${q}`;
  // JSON actions (ui.entityselector.*, tasks.v2.*) send a JSON body; sessid rides the
  // X-Bitrix-Csrf-Token header (added by the caller), never the body.
  if (req.bodyType === "json") {
    return { url, body: JSON.stringify(req.params), contentType: "application/json" };
  }
  const body = encodeForm({ ...req.params, sessid });
  return { url, body, contentType: "application/x-www-form-urlencoded" };
}

// Bitrix wraps errors in HTTP 200: { status:"error", errors:[{code}] } or { error, error_description }.
// NOTE: successful ajax responses carry an EMPTY `errors: []` array — a truthy value in JS — so we
// must treat only a NON-EMPTY errors list (or status:"error"/a top-level error) as a real failure.
export function interpret(json: any): InterpretResult {
  const list = json && (Array.isArray(json.errors) ? json.errors : json.error ? [{ code: json.error }] : []);
  const hasErrors = Array.isArray(list) && list.length > 0;
  if (json && (json.status === "error" || hasErrors)) {
    const first = list[0];
    const code = (first && (first.code || first.message)) || json.error || "bitrix_error";
    const description = json.error_description || (first && first.message);
    const error = description && description !== code ? `${code}: ${description}` : code;
    return { ok: false, error, data: json };
  }
  return { ok: true, data: json };
}
