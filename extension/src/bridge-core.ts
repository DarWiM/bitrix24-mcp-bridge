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
): { url: string; body: string } {
  const q = req.action ? `?action=${encodeURIComponent(req.action)}` : "";
  const url = `${origin}${req.endpoint}${q}`;
  const body = encodeForm({ ...req.params, sessid });
  return { url, body };
}

// Bitrix wraps errors in HTTP 200: { status:"error", errors:[{code}] } or { error, error_description }
export function interpret(json: any): InterpretResult {
  const errors = json && (json.errors ?? (json.error ? [{ code: json.error }] : null));
  if (json && (json.status === "error" || errors)) {
    const first = errors && errors[0];
    const code = (first && (first.code || first.message)) || json.error || "bitrix_error";
    const description = json.error_description || (first && first.message);
    const error = description && description !== code ? `${code}: ${description}` : code;
    return { ok: false, error, data: json };
  }
  return { ok: true, data: json };
}
