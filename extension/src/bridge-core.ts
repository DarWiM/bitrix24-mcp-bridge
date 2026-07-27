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

// Endpoints may carry `{name}` placeholders (e.g. "/call/detail/{callId}"); the value comes
// from params and is consumed there, so it never rides along in the body/query as well.
export function applyPathParams(
  endpoint: string,
  params: Record<string, unknown>,
): { endpoint: string; rest: Record<string, unknown> } {
  const rest = { ...params };
  const filled = endpoint.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = rest[key];
    if (value === null || value === undefined || value === "") {
      throw new Error(`missing path param "${key}" for endpoint ${endpoint}`);
    }
    delete rest[key];
    return encodeURIComponent(String(value));
  });
  return { endpoint: filled, rest };
}

export function buildRequest(
  origin: string,
  req: CallRequest,
  sessid: string,
): { url: string; body: string; contentType: string } {
  const { endpoint, rest } = applyPathParams(req.endpoint, req.params);
  const q = req.action ? `?action=${encodeURIComponent(req.action)}` : "";
  const url = `${origin}${endpoint}${q}`;
  // JSON actions (ui.entityselector.*, tasks.v2.*) send a JSON body; sessid rides the
  // X-Bitrix-Csrf-Token header (added by the caller), never the body.
  if (req.bodyType === "json") {
    return { url, body: JSON.stringify(rest), contentType: "application/json" };
  }
  const body = encodeForm({ ...rest, sessid });
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

// Chunk size for binary downloads: base64 inflates it by ~33%, so a 1 MiB slice stays a
// comfortable WS frame while keeping the message count low for large videos.
export const BINARY_CHUNK_BYTES = 1024 * 1024;

// `btoa` needs a binary string, and String.fromCharCode blows the call stack on big arrays —
// so the array is walked in small windows.
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const window = 0x8000;
  for (let i = 0; i < bytes.length; i += window) {
    binary += String.fromCharCode(...bytes.subarray(i, i + window));
  }
  return btoa(binary);
}

/**
 * The portal answers an unauthenticated download with HTTP 200 and a login PAGE, so the status
 * code cannot be trusted. A genuine file download is marked as an attachment; an HTML body
 * without that marker is the login page, not a .html the user asked for.
 */
export function looksLikeLoginPage(contentType: string, contentDisposition: string | null): boolean {
  return /^\s*text\/html/i.test(contentType) && !/attachment/i.test(contentDisposition ?? "");
}

/** Server-suggested file name, e.g. `attachment; filename="image (29).png"` (RFC 5987 aware). */
export function fileNameFromDisposition(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const encoded = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(contentDisposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
  return plain ? plain[1].trim() : null;
}

// HTML sub-domain (responseType "text"): no Bitrix envelope to read, so the HTTP status is the
// only failure signal we get. A login redirect answers 200 with a page — that one is caught
// downstream, where the parser knows what the payload was supposed to look like.
export function interpretText(text: string, contentType: string, status: number): InterpretResult {
  if (status >= 400) return { ok: false, error: `HTTP ${status}` };
  if (!text.trim()) return { ok: false, error: "empty response" };
  return { ok: true, data: { contentType, text } };
}
