// Pure, browser-agnostic — unit-tested.

export function encodeForm(params) {
  const out = new URLSearchParams();
  const add = (key, val) => {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) val.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof val === "object") for (const [k, v] of Object.entries(val)) add(`${key}[${k}]`, v);
    else out.set(key, String(val));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.toString();
}

export function buildRequest(origin, req, sessid) {
  const q = req.action ? `?action=${encodeURIComponent(req.action)}` : "";
  const url = `${origin}${req.endpoint}${q}`;
  const body = encodeForm({ ...req.params, sessid });
  return { url, body };
}

// Bitrix wraps errors in HTTP 200: { status:"error", errors:[{code}] } or { error, error_description }
export function interpret(json) {
  const errors = json && (json.errors ?? (json.error ? [{ code: json.error }] : null));
  if (json && (json.status === "error" || errors)) {
    return { ok: false, error: (errors && errors[0] && errors[0].code) || "bitrix_error", data: json };
  }
  return { ok: true, data: json };
}
