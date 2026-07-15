import { describe, it, expect, afterEach } from "bun:test";
import WebSocket from "ws";
import { Bridge } from "./server.js";
import type { CallTarget } from "./protocol.js";

const TOKEN = "secret-token";
const PORT = 39931;
let bridge: Bridge;

const target: CallTarget = {
  endpoint: "/bitrix/services/main/ajax.php",
  action: "tasks.task.list",
  method: "POST",
  params: { a: 1 },
};

afterEach(async () => { await bridge?.stop(); });

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("open", () => { ws.send(JSON.stringify({ type: "auth", token })); resolve(ws); });
    ws.on("error", reject);
  });
}

describe("Bridge", () => {
  it("rejects a call when no extension is connected", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [] });
    await bridge.start();
    await expect(bridge.call("", target)).rejects.toThrow(/not connected/i);
  });

  it("round-trips a call to an authenticated extension", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [] });
    await bridge.start();
    const ws = await connect(TOKEN);
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.type !== "call") return;
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: true, data: { tasks: [1, 2] } }));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await bridge.call("", target)).toEqual({ tasks: [1, 2] });
  });

  it("propagates an extension-side error as a rejection", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [] });
    await bridge.start();
    const ws = await connect(TOKEN);
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.type !== "call") return;
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: false, error: "invalid_csrf" }));
    });
    await new Promise((r) => setTimeout(r, 50));
    await expect(bridge.call("", target)).rejects.toThrow(/invalid_csrf/);
  });

  it("closes a socket that sends a wrong token", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [] });
    await bridge.start();
    const ws = await connect("WRONG");
    const closed = await new Promise<boolean>((resolve) => {
      ws.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    expect(closed).toBe(true);
  });
});

async function fakeExtension(port: number, token: string, origin: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "auth", token }));
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "call") {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { echoedFrom: origin } }));
    }
  });
  return ws;
}

describe("Bridge origin routing", () => {
  it("routes a call to the socket matching the origin", async () => {
    const bridge = new Bridge({
      port: 39940,
      token: "t",
      allowedOrigins: ["https://a.bitrix24.ru", "https://b.bitrix24.ru"],
    });
    await bridge.start();
    const a = await fakeExtension(39940, "t", "https://a.bitrix24.ru");
    const b = await fakeExtension(39940, "t", "https://b.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50)); // let auth land

    const res = await bridge.call("https://b.bitrix24.ru", {
      endpoint: "/x", action: null, method: "POST", params: {},
    });
    expect(res).toEqual({ echoedFrom: "https://b.bitrix24.ru" });

    a.close(); b.close();
    await bridge.stop();
  });

  it("rejects an origin outside the allow-set", async () => {
    const bridge = new Bridge({ port: 39941, token: "t", allowedOrigins: ["https://a.bitrix24.ru"] });
    await bridge.start();
    const ws = new WebSocket("ws://127.0.0.1:39941", { headers: { origin: "https://evil.example" } });
    const closed = await new Promise<boolean>((resolve) => {
      ws.on("close", () => resolve(true));
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: "t" })));
    });
    expect(closed).toBe(true);
    await bridge.stop();
  });
});
