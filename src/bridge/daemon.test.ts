import { describe, it, expect } from "bun:test";
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Daemon } from "./daemon.js";
import { encodeFrame, FrameDecoder } from "./frame.js";

const sockIn = () => join(mkdtempSync(join(tmpdir(), "br24d-")), "bridge.sock");

async function fakeExtension(port: number, origin: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "auth", token: "t" }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "call") ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: { ok: origin } }));
  });
  return ws;
}

function udsCall(sockPath: string, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = connect(sockPath);
    const dec = new FrameDecoder();
    c.on("connect", () => c.write(encodeFrame(req)));
    c.on("data", (d) => { const msgs = dec.push(d); if (msgs.length) { resolve(msgs[0]); c.end(); } });
    c.on("error", reject);
  });
}

describe("Daemon", () => {
  it("routes a UDS call to the right portal's extension", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 39950, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await d.start();
    await fakeExtension(39950, "https://acme.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));

    const res = await udsCall(sock, { type: "call", id: "1", portal: "acme", endpoint: "/x", action: null, method: "POST", params: {} });
    expect(res).toEqual({ type: "result", id: "1", ok: true, data: { ok: "https://acme.bitrix24.ru" } });
    await d.stop();
  });

  it("refuses to start a second daemon on the same socket", async () => {
    const sock = sockIn();
    const a = new Daemon({ port: 39951, token: "t", sockPath: sock, portals: { d: { origin: "https://d.bitrix24.ru" } } });
    await a.start();
    const b = new Daemon({ port: 39952, token: "t", sockPath: sock, portals: { d: { origin: "https://d.bitrix24.ru" } } });
    await expect(b.start()).rejects.toThrow(/already running/i);
    await a.stop();
  });
});
