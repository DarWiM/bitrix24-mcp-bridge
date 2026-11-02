import { describe, it, expect, afterEach } from "bun:test";
import { Bridge } from "./server.js";
import { connect, type AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Daemon } from "./daemon.js";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type { CallResult } from "./protocol.js";
import { createRegistry } from "../ops/registry.js";
import { defineOperation } from "../ops/operation.js";

let bridge: Bridge;
let bridge2: Bridge;
afterEach(async () => {
  await bridge?.stop();
  await bridge2?.stop();
});

// Awaits `p` with a timeout; throws `msg` if it hangs instead of settling.
// Returns the rejection reason if `p` rejects, so callers can assert on it.
async function assertRejectsWithTimeout(p: Promise<unknown>, ms: number, msg: string): Promise<unknown> {
  const settled = await Promise.race([
    p.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    new Promise<{ status: "timeout" }>((resolve) => setTimeout(() => resolve({ status: "timeout" }), ms)),
  ]);
  if (settled.status === "timeout") throw new Error(msg);
  if (settled.status === "resolved") throw new Error("expected the promise to reject, but it resolved");
  return settled.error;
}

describe("bridge is loopback-only", () => {
  it("binds to 127.0.0.1", async () => {
    bridge = new Bridge({ port: 39940, token: "t", allowedOrigins: [] });
    await bridge.start();
    // @ts-expect-error reach into the underlying server for the bound address
    const addr = bridge["wss"].address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });

  it("closes a socket sending a wrong token even on loopback", async () => {
    bridge = new Bridge({ port: 39941, token: "right", allowedOrigins: [] });
    await bridge.start();
    const ws = new WebSocket("ws://127.0.0.1:39941");
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: "wrong" }));
    const closed = await new Promise<boolean>((res) => {
      ws.on("close", () => res(true));
      setTimeout(() => res(false), 500);
    });
    expect(closed).toBe(true);
  });
});

describe("bridge start() rejects on server error", () => {
  it("rejects when a second bridge starts on an already-bound port", async () => {
    bridge = new Bridge({ port: 39942, token: "t", allowedOrigins: [] });
    await bridge.start();
    bridge2 = new Bridge({ port: 39942, token: "t", allowedOrigins: [] });
    const err = await assertRejectsWithTimeout(
      bridge2.start(),
      2000,
      "start() hung instead of rejecting on EADDRINUSE",
    );
    expect(err).toBeInstanceOf(Error);
  });
});

describe("bridge enforces allowedOrigin", () => {
  const PORT = 39943;
  const TOKEN = "right";
  const ALLOWED = "https://portal.bitrix24.ru";

  it("closes a connection whose Origin header mismatches allowedOrigin, even with the correct token", async () => {
    bridge = new Bridge({ port: PORT, token: TOKEN, allowedOrigins: [ALLOWED] });
    await bridge.start();
    // Bun's built-in `ws`-compatible client only honors an explicit `headers`
    // option (not the ws-package `origin` shorthand) — see extension/README.md
    // security notes for why this still exercises the real Origin check.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: "https://evil.example" } });
    const closed = await new Promise<boolean>((res) => {
      ws.on("open", () => { ws.send(JSON.stringify({ type: "auth", token: TOKEN })); });
      ws.on("close", () => res(true));
      setTimeout(() => res(false), 1000);
    });
    expect(closed).toBe(true);
  });

  it("authenticates a connection with a matching Origin + correct token", async () => {
    bridge = new Bridge({ port: PORT + 1, token: TOKEN, allowedOrigins: [ALLOWED] });
    await bridge.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT + 1}`, { headers: { Origin: ALLOWED } });
    const notClosed = await new Promise<boolean>((res) => {
      ws.on("open", () => { ws.send(JSON.stringify({ type: "auth", token: TOKEN })); });
      ws.on("close", () => res(false));
      setTimeout(() => res(true), 400);
    });
    expect(notClosed).toBe(true);
    expect(bridge.connectedOrigins()).toContain(ALLOWED);
    ws.close();
  });

  it("authenticates a connection with no Origin header + correct token", async () => {
    bridge = new Bridge({ port: PORT + 2, token: TOKEN, allowedOrigins: [ALLOWED] });
    await bridge.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT + 2}`);
    const notClosed = await new Promise<boolean>((res) => {
      ws.on("open", () => { ws.send(JSON.stringify({ type: "auth", token: TOKEN })); });
      ws.on("close", () => res(false));
      setTimeout(() => res(true), 400);
    });
    expect(notClosed).toBe(true);
    expect(bridge.connectedOrigins()).toContain("");
    ws.close();
  });
});

function udsRequest(sockPath: string, frame: object): Promise<CallResult> {
  return new Promise<CallResult>((resolve, reject) => {
    const c = connect(sockPath);
    const dec = new FrameDecoder();
    c.on("connect", () => c.write(encodeFrame(frame)));
    c.on("data", (chunk) => { const [m] = dec.push(chunk) as CallResult[]; if (m) { resolve(m); c.end(); } });
    c.on("error", reject);
  });
}

describe("daemon enforces the mutation policy", () => {
  it("refuses a mutating op when mutations are disabled, without reaching the portal", async () => {
    let ran = false;
    const mutate = defineOperation({
      name: "mutate", description: "test", mutating: true, input: {},
      run: async () => { ran = true; return null; },
    });
    const sock = join(mkdtempSync(join(tmpdir(), "br24s-")), "bridge.sock");
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      defaultPortal: "acme", downloadsDir: tmpdir(), allowMutations: false,
      registry: createRegistry([mutate]),
    });
    await d.start();
    try {
      const res = await udsRequest(sock, { type: "op", id: "1", op: "mutate", args: {} });
      expect(res.id).toBe("1");
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/mutations/);
      expect(ran).toBe(false);
    } finally {
      await d.stop();
    }
  });
});

describe("daemon accepts only built-in operations", () => {
  it("refuses a raw call frame without forwarding anything to the extension", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24s-")), "bridge.sock");
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      defaultPortal: "acme", downloadsDir: tmpdir(), allowMutations: true,
    });
    await d.start();
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}`, { headers: { origin: "https://acme.bitrix24.ru" } });
    try {
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ type: "auth", token: "t" }));
      const forwarded: unknown[] = [];
      ws.on("message", (raw) => forwarded.push(raw.toString()));
      await new Promise((r) => setTimeout(r, 50));

      const res = await udsRequest(sock, {
        type: "call", id: "1", portal: "acme",
        endpoint: "/bitrix/services/main/ajax.php", action: "tasks.task.delete", method: "POST", params: { taskId: 1 },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(res).toEqual({ type: "result", id: "1", ok: false, error: "unsupported request type call" });
      expect(forwarded).toEqual([]);
    } finally {
      ws.close();
      await d.stop();
    }
  });
});
