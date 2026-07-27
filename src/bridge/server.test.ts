import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("rejects promptly (not after the 30s timeout) when send() throws after socket selection", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [] });
    await bridge.start();
    await connect(TOKEN);
    await new Promise((r) => setTimeout(r, 50));
    // @ts-expect-error reach into internals to simulate the socket closing between selection and send
    const live = [...bridge["byOrigin"].get("")][0];
    live.send = () => { throw new Error("boom"); };
    await expect(bridge.call("", target)).rejects.toThrow(/send to portal .* failed: boom/);
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

describe("Bridge binary downloads", () => {
  const temps: string[] = [];
  afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

  function tempDest(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "br24-bin-"));
    temps.push(dir);
    return join(dir, name);
  }

  /** Stands in for the extension: answers a binary call with begin → chunks → result. */
  function serveBytes(ws: WebSocket, bytes: Buffer, chunkSize: number, contentType = "image/png") {
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.type !== "call") return;
      ws.send(JSON.stringify({ type: "binary-begin", id: req.id, contentType, bytes: bytes.length, fileName: "photo.png" }));
      let seq = 0;
      for (let at = 0; at < bytes.length; at += chunkSize) {
        ws.send(JSON.stringify({ type: "binary-chunk", id: req.id, seq: seq++, data: bytes.subarray(at, at + chunkSize).toString("base64") }));
      }
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: true, data: { contentType, bytes: bytes.length } }));
    });
  }

  it("writes streamed chunks to the destination byte-for-byte", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [] });
    await bridge.start();
    const ws = await connect(TOKEN);
    // Binary payload with bytes that would not survive a UTF-8 round trip.
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    serveBytes(ws, bytes, 777);
    const dest = tempDest("photo.png");
    await new Promise((r) => setTimeout(r, 50));

    const result = await bridge.callBinary("", target, dest);

    expect(result).toEqual({ path: dest, bytes: bytes.length, contentType: "image/png", fileName: "photo.png" });
    expect(readFileSync(dest).equals(bytes)).toBe(true);
    ws.close();
  });

  it("creates missing parent directories", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [] });
    await bridge.start();
    const ws = await connect(TOKEN);
    const bytes = Buffer.from("payload");
    serveBytes(ws, bytes, 4);
    const dest = join(tempDest("x"), "..", "nested", "deep", "file.bin");
    await new Promise((r) => setTimeout(r, 50));

    const result = await bridge.callBinary("", target, dest);

    expect(readFileSync(result.path).equals(bytes)).toBe(true);
    ws.close();
  });

  it("leaves no half-written file behind when the download fails", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [] });
    await bridge.start();
    const ws = await connect(TOKEN);
    const dest = tempDest("partial.bin");
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.type !== "call") return;
      ws.send(JSON.stringify({ type: "binary-begin", id: req.id, contentType: "image/png", bytes: 99, fileName: null }));
      ws.send(JSON.stringify({ type: "binary-chunk", id: req.id, seq: 0, data: Buffer.from("half").toString("base64") }));
      ws.send(JSON.stringify({ type: "result", id: req.id, ok: false, error: "portal answered with an HTML page, not a file" }));
    });

    await new Promise((r) => setTimeout(r, 50));

    await expect(bridge.callBinary("", target, dest)).rejects.toThrow(/HTML page/);
    expect(existsSync(dest)).toBe(false);
    ws.close();
  });

  it("ignores binary frames for a call it never made", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [] });
    await bridge.start();
    const ws = await connect(TOKEN);
    const dest = tempDest("stray.bin");
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "binary-begin", id: "not-mine", contentType: "image/png", bytes: 1, fileName: null }));
    ws.send(JSON.stringify({ type: "binary-chunk", id: "not-mine", seq: 0, data: Buffer.from("x").toString("base64") }));
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(dest)).toBe(false);
    ws.close();
  });
});
