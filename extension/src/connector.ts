// ISOLATED-world connector. This is where the token and the WebSocket live — never in
// the page's MAIN world, so the page cannot read the token without knowing the dynamic
// (`use_dynamic_url`) resource URL for config.json, and cannot hijack the socket. It has
// `chrome.runtime`, so it loads the per-user config from the packaged config.json at
// runtime (nothing per-user is baked into this JS — the file is static). The actual
// boundary is `use_dynamic_url: true` on config.json in the manifest: it makes the
// resource URL unguessable from the page while `chrome.runtime.getURL()` here still
// resolves it.
//
// Per daemon call it asks the MAIN shim for a FRESH sessid over postMessage (nonce-matched),
// then reuses the pure bridge-core helpers to build the request, fetch it with the page's
// cookies, and interpret the response.

import { buildRequest, interpret, type CallRequest, type InterpretResult } from "./bridge-core.ts";
import {
  parseConfig,
  buildSessidRequest,
  parseSessidResponse,
  parseCaptureForward,
  type BridgeConfig,
} from "./bridge-protocol.ts";

// Gates the capture relay listener; stripped from normal builds via esbuild `define`.
declare const __BITRIX_CAPTURE__: boolean;

// Minimal ambient for the one chrome API we use (no @types/chrome dependency).
declare const chrome: { runtime: { getURL(path: string): string } };

const ORIGIN = location.origin;
const SESSID_TIMEOUT_MS = 2000;
const RECONNECT_MS = 3000;

let socket: WebSocket | null = null;
let nonceSeq = 0;

/** Ask the MAIN shim for a fresh sessid; resolves "" if it doesn't answer in time. */
function freshSessid(): Promise<string> {
  const nonce = `${Date.now()}-${nonceSeq++}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const onMsg = (ev: MessageEvent): void => {
      if (ev.source !== window) return;
      const res = parseSessidResponse(ev.data, nonce);
      if (!res) return;
      cleanup();
      resolve(res.sessid);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve("");
    }, SESSID_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
    };
    window.addEventListener("message", onMsg);
    window.postMessage(buildSessidRequest(nonce), ORIGIN);
  });
}

async function handleCall(req: CallRequest): Promise<InterpretResult> {
  const sessid = await freshSessid();
  if (!sessid) return { ok: false, error: "session context not ready — open a normal Bitrix24 portal tab" }; // G5
  const { url, body, contentType } = buildRequest(ORIGIN, req, sessid);
  const init: RequestInit = {
    method: req.method,
    credentials: "include",
    // sessid rides the CSRF header for all ajax (v2 form + json); form bodies also carry it inline.
    headers: { "Content-Type": contentType, "X-Bitrix-Csrf-Token": sessid },
  };
  let finalUrl = url;
  if (req.method === "POST") init.body = body;
  else finalUrl += (url.includes("?") ? "&" : "?") + body;
  const resp = await fetch(finalUrl, init);
  const json = await resp.json();
  return interpret(json); // G3
}

function connect(config: BridgeConfig): void {
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "auth", token: config.token })); // auth first (server closes non-auth)
    socket = ws;
  });
  ws.addEventListener("message", async (ev: MessageEvent) => {
    let req: CallRequest;
    try {
      req = JSON.parse(ev.data) as CallRequest;
    } catch (e) {
      console.error("[bitrix-bridge] malformed WS frame, dropping:", e);
      return;
    }
    if (req.type !== "call") return;
    try {
      const r = await handleCall(req);
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: r.ok, data: r.data, error: r.error }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: false, error: String(e) }));
    }
  });
  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
    setTimeout(() => connect(config), RECONNECT_MS); // auto-reconnect
  });
}

// Capture build only: relay MAIN-observed capture entries to the daemon.
if (__BITRIX_CAPTURE__) {
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const fwd = parseCaptureForward(ev.data);
    if (!fwd) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "capture", call: fwd.call }));
    }
  });
}

async function start(): Promise<void> {
  let config: BridgeConfig;
  try {
    const resp = await fetch(chrome.runtime.getURL("config.json"));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    config = parseConfig(await resp.text());
  } catch (e) {
    // Nothing to fall back to — surface why the bridge won't start and stop.
    console.error("[bitrix-bridge] cannot load config.json:", e);
    return;
  }
  connect(config);
}

start();
