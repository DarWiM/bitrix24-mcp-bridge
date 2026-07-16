import { describe, it, expect } from "bun:test";
import { connect } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Daemon } from "./daemon.js";
import { Bridge } from "./server.js";
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
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await d.start();
    await fakeExtension(d.port, "https://acme.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));

    const res = await udsCall(sock, { type: "call", id: "1", portal: "acme", endpoint: "/x", action: null, method: "POST", params: {} });
    expect(res).toEqual({ type: "result", id: "1", ok: true, data: { ok: "https://acme.bitrix24.ru" } });
    await d.stop();
  });

  it("locks the UDS socket down to 0600 regardless of umask", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await d.start();
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    await d.stop();
  });

  it("refuses to start a second daemon on the same port + socket, winner keeps working", async () => {
    // Singleton is gated by the WS port: the loser must reject and must NOT touch
    // the winner's live socket.
    const sock = sockIn();
    const a = new Daemon({ port: 0, token: "t", sockPath: sock, portals: { d: { origin: "https://d.bitrix24.ru" } } });
    await a.start();
    const b = new Daemon({ port: a.port, token: "t", sockPath: sock, portals: { d: { origin: "https://d.bitrix24.ru" } } });
    await expect(b.start()).rejects.toThrow(/already running/i);

    // A guarded loser calling stop() must NOT unlink the winner's live socket
    // (ownsSocket stayed false because it never bound the UDS).
    await b.stop();
    expect(existsSync(sock)).toBe(true);

    // Winner's UDS still routes after the loser bailed out and stopped.
    await fakeExtension(a.port, "https://d.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));
    const res = await udsCall(sock, { type: "call", id: "9", portal: "d", endpoint: "/x", action: null, method: "POST", params: {} });
    expect(res).toEqual({ type: "result", id: "9", ok: true, data: { ok: "https://d.bitrix24.ru" } });
    await a.stop();
  });

  it("exits on idle when no clients and no extension are connected", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, idleMs: 100,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await d.start();
    expect(existsSync(sock)).toBe(true);

    // Generous margin: after ~idleMs with nothing connected, the daemon stops itself
    // and its socket file is gone.
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(sock)).toBe(false);
  });

  it("re-arms (does NOT exit) while an extension stays connected", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, idleMs: 100,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await d.start();
    await fakeExtension(d.port, "https://acme.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));

    // Wait well past several idle intervals; the connected extension keeps it alive.
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(sock)).toBe(true);

    const res = await udsCall(sock, { type: "call", id: "2", portal: "acme", endpoint: "/x", action: null, method: "POST", params: {} });
    expect(res).toEqual({ type: "result", id: "2", ok: true, data: { ok: "https://acme.bitrix24.ru" } });
    await d.stop();
  });

  it("survives a malformed UDS frame and keeps serving valid calls", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await d.start();
    await fakeExtension(d.port, "https://acme.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));

    // Push garbage that fails JSON.parse in the data listener.
    await new Promise<void>((resolve, reject) => {
      const c = connect(sock);
      c.on("connect", () => { c.write("not json\n"); c.end(resolve); });
      c.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 30));

    // A fresh, valid call still succeeds → the daemon did not crash.
    const res = await udsCall(sock, { type: "call", id: "3", portal: "acme", endpoint: "/x", action: null, method: "POST", params: {} });
    expect(res).toEqual({ type: "result", id: "3", ok: true, data: { ok: "https://acme.bitrix24.ru" } });
    await d.stop();
  });

  it("a stopped daemon's idle timer never deletes a NEW daemon's socket (cross-generation race)", async () => {
    // Daemon A arms a short idle timer, then stops. Its destroys fire close/error
    // handlers that (pre-fix) re-armed the timer past stop()'s clear. Daemon B then
    // reclaims the SAME port + socket path. If A's dead timer fired, it would stop()
    // again and unlink B's live socket. It must not.
    const sock = sockIn();
    const a = new Daemon({
      port: 0, token: "t", sockPath: sock, idleMs: 60,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await a.start();
    const port = a.port;
    // Open + immediately close a client so a close handler is queued behind stop().
    await new Promise<void>((resolve, reject) => {
      const c = connect(sock);
      c.on("connect", () => c.end(resolve));
      c.on("error", reject);
    });
    await a.stop();

    const b = new Daemon({
      port, token: "t", sockPath: sock, idleMs: 5_000,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await b.start();
    expect(existsSync(sock)).toBe(true);

    // Wait well past A's idleMs: A's stopped timer must not have fired to delete B's socket.
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(sock)).toBe(true);

    // And B still routes.
    await fakeExtension(b.port, "https://acme.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));
    const res = await udsCall(sock, { type: "call", id: "7", portal: "acme", endpoint: "/x", action: null, method: "POST", params: {} });
    expect(res).toEqual({ type: "result", id: "7", ok: true, data: { ok: "https://acme.bitrix24.ru" } });
    await b.stop();
  });

  it("releases the WS port when UDS initialization fails (partial-init rollback)", async () => {
    // Force listen()/unlink to fail by placing a DIRECTORY at the socket path: the
    // start() UDS branch throws after bridge.start() already bound the port. The
    // rollback must release that port so a fresh Bridge can bind it.
    const sock = sockIn();
    mkdirSync(sock); // now sockPath is a dir → unlinkSync/listen fails

    // Reserve an ephemeral port up front so the assertion below proves THIS
    // specific port was released, not just that some free port exists.
    const reserving = new Bridge({ port: 0, token: "t", allowedOrigins: [] });
    await reserving.start();
    const port = reserving.port;
    await reserving.stop();

    const d = new Daemon({
      port, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await expect(d.start()).rejects.toThrow();

    // The port must be free again — a fresh Bridge binds it without EADDRINUSE.
    const probe = new Bridge({ port, token: "t", allowedOrigins: [] });
    await probe.start();
    await probe.stop();
  });

  it("replies to {type:'status'} with each configured portal and its connected flag", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await d.start();
    try {
      const res = await udsCall(sock, { type: "status", id: "1" });
      expect(res.ok).toBe(true);
      expect(res.data.portals).toEqual([
        { alias: "acme", origin: "https://acme.bitrix24.ru", connected: false },
      ]);
    } finally {
      await d.stop();
    }
  });

  it("exposes the actual bound port and gracefully shuts down on a {type:'shutdown'} frame", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
    });
    await d.start();
    expect(d.port).toBeGreaterThan(0);

    const res = await udsCall(sock, { type: "shutdown", id: "1" });
    expect(res).toEqual({ type: "result", id: "1", ok: true, data: { stopping: true } });

    // The reply must flush BEFORE the daemon actually stops; give it a beat, then
    // confirm the socket is gone (daemon torn itself down).
    await new Promise((r) => setTimeout(r, 500));
    await expect(
      new Promise((resolve, reject) => {
        const c = connect(sock);
        c.on("connect", () => { c.end(); resolve(undefined); });
        c.on("error", reject);
      }),
    ).rejects.toThrow();
  });
});
