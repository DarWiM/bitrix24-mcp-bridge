// Capture (recording) mode — bundled only into the capture build (__BITRIX_CAPTURE__).
// Hooks fetch/XHR on the portal page, classifies API calls, and streams them to the
// bridge as { type: "capture", call }. The recorder (src/capture-server.ts) writes the draft.

import type { CapturedEntry } from "./bridge-core.ts";
import { parseBody } from "../../shared/body-params.ts";

const STATIC_EXT = /\.(js|css|png|svg|jpe?g|gif|woff2?|ico|map)$/i;

function classify(pathname: string): CapturedEntry["transport"] {
  if (pathname.endsWith("/bitrix/services/main/ajax.php")) return "ajax";
  if (pathname.includes("/rest/")) return "rest";
  return "other";
}

function bodyToParams(body: unknown): { params: Record<string, unknown>; bodyType: "json" | "form" } {
  if (typeof body === "string") {
    const { params, bodyType } = parseBody(body);
    delete params.sessid; // never record the rotating CSRF token
    return { params, bodyType };
  }
  const params: Record<string, string> = {};
  if (body instanceof URLSearchParams) {
    for (const [k, v] of body) { if (k !== "sessid") params[k] = v; }
  } else if (typeof FormData !== "undefined" && body instanceof FormData) {
    for (const [k, v] of body) { if (k !== "sessid") params[k] = String(v); }
  }
  return { params, bodyType: "form" };
}

/**
 * Pure: turn one observed request into a draft entry, or null if it's not a
 * portal API call (static asset, cross-origin, or non-API same-origin URL).
 */
export function toCaptured(
  rawUrl: string,
  method: string,
  body: unknown,
  base: string,
): CapturedEntry | null {
  let url: URL;
  try {
    url = new URL(rawUrl, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null; // only the portal
  if (STATIC_EXT.test(url.pathname)) return null; // drop assets
  const looksApi = url.pathname.includes("ajax.php") || url.pathname.includes("/rest/");
  if (!looksApi) return null;
  const { params, bodyType } = bodyToParams(body);
  return {
    endpoint: url.pathname,
    action: url.searchParams.get("action"),
    method: method.toUpperCase() === "GET" ? "GET" : "POST",
    transport: classify(url.pathname),
    bodyType,
    sampleParams: params,
  };
}

export function installCapture(send: (call: CapturedEntry) => void): void {
  const seen = new Set<string>();
  const badge = makeBadge();

  const record = (rawUrl: string, method: string, body: unknown): void => {
    const call = toCaptured(rawUrl, method, body, location.origin);
    if (!call) return;
    send(call);
    seen.add(call.action ?? call.endpoint);
    badge.textContent = `● REC — ${seen.size} action(s)`;
  };

  // fetch
  const origFetch = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    try {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      record(url, method, init?.body);
    } catch {
      /* best-effort */
    }
    return origFetch.apply(this, arguments as unknown as [RequestInfo | URL, RequestInit?]);
  };

  // XMLHttpRequest
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]) {
    (this as any).__cap = { method, url };
    // @ts-expect-error variadic passthrough
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const c = (this as any).__cap;
      if (c) record(c.url, c.method, body);
    } catch {
      /* best-effort */
    }
    return origSend.call(this, body ?? null);
  };
}

function makeBadge(): HTMLElement {
  const el = document.createElement("div");
  el.textContent = "● REC — 0 action(s)";
  Object.assign(el.style, {
    position: "fixed",
    bottom: "12px",
    right: "12px",
    zIndex: "2147483647",
    background: "#c0392b",
    color: "#fff",
    font: "12px/1.4 system-ui, sans-serif",
    padding: "6px 10px",
    borderRadius: "6px",
    boxShadow: "0 2px 8px rgba(0,0,0,.3)",
    pointerEvents: "none",
  } as CSSStyleDeclaration);
  const mount = () => document.body?.appendChild(el);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
  return el;
}
