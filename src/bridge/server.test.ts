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
    bridge = new Bridge({ port: PORT, token: TOKEN });
    await bridge.start();
    await expect(bridge.call(target)).rejects.toThrow(/not connected/i);
  });

  it("round-trips a call to an authenticated extension", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN });
    await bridge.start();
    const ws = await connect(TOKEN);
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.type !== "call") return;
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: true, data: { tasks: [1, 2] } }));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await bridge.call(target)).toEqual({ tasks: [1, 2] });
  });

  it("propagates an extension-side error as a rejection", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN });
    await bridge.start();
    const ws = await connect(TOKEN);
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.type !== "call") return;
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: false, error: "invalid_csrf" }));
    });
    await new Promise((r) => setTimeout(r, 50));
    await expect(bridge.call(target)).rejects.toThrow(/invalid_csrf/);
  });

  it("closes a socket that sends a wrong token", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN });
    await bridge.start();
    const ws = await connect("WRONG");
    const closed = await new Promise<boolean>((resolve) => {
      ws.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    expect(closed).toBe(true);
  });
});
