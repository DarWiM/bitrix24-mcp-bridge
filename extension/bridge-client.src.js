import { buildRequest, interpret } from "./bridge-core.js";

// __BITRIX_TOKEN__ / __BITRIX_PORT__ are injected at build time by
// scripts/build-extension.ts (esbuild `define`) from the .env config.
const TOKEN = __BITRIX_TOKEN__;
const PORT = __BITRIX_PORT__;
const ORIGIN = location.origin;

function freshSessid() {
  return (window.BX && window.BX.bitrix_sessid && window.BX.bitrix_sessid()) || "";
}

async function handleCall(req) {
  const sessid = freshSessid();
  if (!sessid) return { ok: false, error: "session context not ready — open a normal Bitrix24 portal tab" }; // G5
  const { url, body } = buildRequest(ORIGIN, req, sessid);
  const init = { method: req.method, credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded" } };
  let finalUrl = url;
  if (req.method === "POST") init.body = body;
  else finalUrl += (url.includes("?") ? "&" : "?") + body;
  const resp = await fetch(finalUrl, init);
  const json = await resp.json();
  return interpret(json); // G3
}

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", token: TOKEN })));
  ws.addEventListener("message", async (ev) => {
    const req = JSON.parse(ev.data);
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
