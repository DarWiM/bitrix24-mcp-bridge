import { buildRequest, interpret, type CallRequest, type InterpretResult } from "./bridge-core.ts";

// Injected at build time by scripts/build-extension.ts (esbuild `define`) from .env.
declare const __BITRIX_TOKEN__: string;
declare const __BITRIX_PORT__: number;

// window.BX is provided by the Bitrix24 page itself (MAIN world).
declare global {
  interface Window {
    BX?: { bitrix_sessid?: () => string };
  }
}

const TOKEN: string = __BITRIX_TOKEN__;
const PORT: number = __BITRIX_PORT__;
const ORIGIN = location.origin;

function freshSessid(): string {
  return (window.BX?.bitrix_sessid?.()) || "";
}

async function handleCall(req: CallRequest): Promise<InterpretResult> {
  const sessid = freshSessid();
  if (!sessid) return { ok: false, error: "session context not ready — open a normal Bitrix24 portal tab" }; // G5
  const { url, body } = buildRequest(ORIGIN, req, sessid);
  const init: RequestInit = {
    method: req.method,
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
  let finalUrl = url;
  if (req.method === "POST") init.body = body;
  else finalUrl += (url.includes("?") ? "&" : "?") + body;
  const resp = await fetch(finalUrl, init);
  const json = await resp.json();
  return interpret(json); // G3
}

function connect(): void {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", token: TOKEN })));
  ws.addEventListener("message", async (ev: MessageEvent) => {
    const req = JSON.parse(ev.data) as CallRequest;
    if (req.type !== "call") return;
    try {
      const r = await handleCall(req);
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: r.ok, data: r.data, error: r.error }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: false, error: String(e) }));
    }
  });
  ws.addEventListener("close", () => setTimeout(connect, 3000)); // auto-reconnect
}
connect();
