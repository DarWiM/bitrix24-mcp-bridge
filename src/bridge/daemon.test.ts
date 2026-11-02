import { describe, it, expect } from "bun:test";
import { connect } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Daemon } from "./daemon.js";
import { Bridge } from "./server.js";
import { encodeFrame, FrameDecoder } from "./frame.js";
import { z } from "zod";
import { createRegistry } from "../ops/registry.js";
import { defineOperation } from "../ops/operation.js";
import { PACKAGE_VERSION } from "../version.js";

const sockIn = () => join(mkdtempSync(join(tmpdir(), "br24d-")), "bridge.sock");
const opDefaults = (defaultPortal: string) => ({ defaultPortal, downloadsDir: tmpdir(), allowMutations: true });

// Sends one fixed request to the portal: these tests are about the daemon's routing, not an operation.
const relayOp = defineOperation({
  name: "relay",
  description: "test",
  mutating: false,
  input: { bodyType: z.enum(["json", "form"]).optional() },
  run: (ctx, args) => ctx.call({ endpoint: "/x", action: null, method: "POST", params: {}, ...(args.bodyType ? { bodyType: args.bodyType } : {}) }),
});
const relayDefaults = (defaultPortal: string) => ({ ...opDefaults(defaultPortal), registry: createRegistry([relayOp]) });

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
  it("routes an operation's request to the right portal's extension", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      ...relayDefaults("acme"),
    });
    await d.start();
    await fakeExtension(d.port, "https://acme.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));

    const res = await udsCall(sock, { type: "op", id: "1", portal: "acme", op: "relay", args: {} });
    expect(res).toEqual({ type: "result", id: "1", ok: true, data: { ok: "https://acme.bitrix24.ru" } });
    await d.stop();
  });

  it("locks the UDS socket down to 0600 regardless of umask", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      ...relayDefaults("acme"),
    });
    await d.start();
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    await d.stop();
  });

  it("refuses to start a second daemon on the same port + socket, winner keeps working", async () => {
    // Singleton is gated by the WS port: the loser must reject and must NOT touch
    // the winner's live socket.
    const sock = sockIn();
    const a = new Daemon({ port: 0, token: "t", sockPath: sock, portals: { d: { origin: "https://d.bitrix24.ru" } }, ...relayDefaults("d") });
    await a.start();
    const b = new Daemon({ port: a.port, token: "t", sockPath: sock, portals: { d: { origin: "https://d.bitrix24.ru" } }, ...relayDefaults("d") });
    await expect(b.start()).rejects.toThrow(/already running/i);

    // A guarded loser calling stop() must NOT unlink the winner's live socket
    // (ownsSocket stayed false because it never bound the UDS).
    await b.stop();
    expect(existsSync(sock)).toBe(true);

    // Winner's UDS still routes after the loser bailed out and stopped.
    await fakeExtension(a.port, "https://d.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));
    const res = await udsCall(sock, { type: "op", id: "9", portal: "d", op: "relay", args: {} });
    expect(res).toEqual({ type: "result", id: "9", ok: true, data: { ok: "https://d.bitrix24.ru" } });
    await a.stop();
  });

  it("exits on idle when no clients and no extension are connected", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, idleMs: 100,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      ...relayDefaults("acme"),
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
      ...relayDefaults("acme"),
    });
    await d.start();
    await fakeExtension(d.port, "https://acme.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));

    // Wait well past several idle intervals; the connected extension keeps it alive.
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(sock)).toBe(true);

    const res = await udsCall(sock, { type: "op", id: "2", portal: "acme", op: "relay", args: {} });
    expect(res).toEqual({ type: "result", id: "2", ok: true, data: { ok: "https://acme.bitrix24.ru" } });
    await d.stop();
  });

  it("survives a malformed UDS frame and keeps serving valid calls", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      ...relayDefaults("acme"),
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
    const res = await udsCall(sock, { type: "op", id: "3", portal: "acme", op: "relay", args: {} });
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
      ...relayDefaults("acme"),
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
      ...relayDefaults("acme"),
    });
    await b.start();
    expect(existsSync(sock)).toBe(true);

    // Wait well past A's idleMs: A's stopped timer must not have fired to delete B's socket.
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(sock)).toBe(true);

    // And B still routes.
    await fakeExtension(b.port, "https://acme.bitrix24.ru");
    await new Promise((r) => setTimeout(r, 50));
    const res = await udsCall(sock, { type: "op", id: "7", portal: "acme", op: "relay", args: {} });
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
      ...relayDefaults("acme"),
    });
    await expect(d.start()).rejects.toThrow();

    // The port must be free again — a fresh Bridge binds it without EADDRINUSE.
    const probe = new Bridge({ port, token: "t", allowedOrigins: [] });
    await probe.start();
    await probe.stop();
  });

  it("forwards an operation request's bodyType to the extension", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      ...relayDefaults("acme"),
    });
    await d.start();
    // fake extension that echoes the received bodyType back in the result
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}`, { headers: { origin: "https://acme.bitrix24.ru" } });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: "t" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "call") ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: { bodyType: m.bodyType } }));
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await udsCall(sock, { type: "op", id: "1", portal: "acme", op: "relay", args: { bodyType: "json" } });
    expect(res.data).toEqual({ bodyType: "json" });
    await d.stop();
  });

  it("replies to {type:'status'} with each configured portal and its connected flag", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      ...relayDefaults("acme"),
    });
    await d.start();
    try {
      const res = await udsCall(sock, { type: "status", id: "1" });
      expect(res.ok).toBe(true);
      expect(res.data.portals).toEqual([
        { alias: "acme", origin: "https://acme.bitrix24.ru", connected: false, extensionVersion: null },
      ]);
      expect(res.data.version).toBe(PACKAGE_VERSION);
    } finally {
      await d.stop();
    }
  });

  it("exposes the actual bound port and gracefully shuts down on a {type:'shutdown'} frame", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock,
      portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      ...relayDefaults("acme"),
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

const twoPortals = {
  acme: { origin: "https://acme.bitrix24.ru" },
  beta: { origin: "https://beta.bitrix24.ru" },
};

// Echoes which portal the daemon picked and where the request actually went.
const whereOp = defineOperation({
  name: "where",
  description: "test",
  mutating: false,
  input: { via: z.string().optional() },
  run: async (ctx, args) => ({
    portal: ctx.portal,
    origin: ctx.origin,
    origins: ctx.origins,
    reply: await ctx.call({ endpoint: "/x", action: null, method: "POST", params: {} }, args.via),
  }),
});

describe("Daemon operations", () => {
  it("runs an op frame on the default portal when it names none, with two portals configured", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, portals: twoPortals,
      ...opDefaults("beta"), registry: createRegistry([whereOp]),
    });
    await d.start();
    try {
      await fakeExtension(d.port, "https://acme.bitrix24.ru");
      await fakeExtension(d.port, "https://beta.bitrix24.ru");
      await new Promise((r) => setTimeout(r, 50));

      const res = await udsCall(sock, { type: "op", id: "1", op: "where", args: {} });
      expect(res).toEqual({
        type: "result", id: "1", ok: true,
        data: {
          portal: "beta",
          origin: "https://beta.bitrix24.ru",
          origins: { acme: "https://acme.bitrix24.ru", beta: "https://beta.bitrix24.ru" },
          reply: { ok: "https://beta.bitrix24.ru" },
        },
      });
    } finally {
      await d.stop();
    }
  });

  it("routes a single request to the portal an op overrides it with", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, portals: twoPortals,
      ...opDefaults("beta"), registry: createRegistry([whereOp]),
    });
    await d.start();
    try {
      await fakeExtension(d.port, "https://acme.bitrix24.ru");
      await fakeExtension(d.port, "https://beta.bitrix24.ru");
      await new Promise((r) => setTimeout(r, 50));

      const res = await udsCall(sock, { type: "op", id: "2", portal: "beta", op: "where", args: { via: "acme" } });
      expect(res.ok).toBe(true);
      expect(res.data.portal).toBe("beta");
      expect(res.data.reply).toEqual({ ok: "https://acme.bitrix24.ru" });
    } finally {
      await d.stop();
    }
  });

  it("refuses an override alias that is not configured", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, portals: twoPortals,
      ...opDefaults("acme"), registry: createRegistry([whereOp]),
    });
    await d.start();
    try {
      const res = await udsCall(sock, { type: "op", id: "3", op: "where", args: { via: "constructor" } });
      expect(res).toEqual({ type: "result", id: "3", ok: false, error: 'unknown portal "constructor"' });
    } finally {
      await d.stop();
    }
  });

  it("answers an op frame naming an unknown portal with an error", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, portals: twoPortals,
      ...opDefaults("acme"), registry: createRegistry([whereOp]),
    });
    await d.start();
    try {
      const res = await udsCall(sock, { type: "op", id: "4", portal: "nope", op: "where", args: {} });
      expect(res).toEqual({ type: "result", id: "4", ok: false, error: 'unknown portal "nope"' });
    } finally {
      await d.stop();
    }
  });

  it("reports invalid op arguments as an error reply", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, portals: twoPortals,
      ...opDefaults("acme"), registry: createRegistry([whereOp]),
    });
    await d.start();
    try {
      const res = await udsCall(sock, { type: "op", id: "5", op: "where", args: { via: 42 } });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/invalid arguments for where/);
    } finally {
      await d.stop();
    }
  });

  it("serves the real operation set by default", async () => {
    const sock = sockIn();
    const d = new Daemon({ port: 0, token: "t", sockPath: sock, portals: twoPortals, ...opDefaults("acme") });
    await d.start();
    try {
      const res = await udsCall(sock, { type: "op", id: "6", op: "no_such_op", args: {} });
      expect(res).toEqual({ type: "result", id: "6", ok: false, error: 'unknown operation "no_such_op"' });
      // A known op gets past the registry and only fails because no extension is connected.
      const known = await udsCall(sock, { type: "op", id: "7", op: "task_get", args: { taskId: 1 } });
      expect(known.ok).toBe(false);
      expect(known.error).toMatch(/not connected/);
    } finally {
      await d.stop();
    }
  });

  it("answers an unsupported frame type instead of staying silent", async () => {
    const sock = sockIn();
    const d = new Daemon({ port: 0, token: "t", sockPath: sock, portals: twoPortals, ...opDefaults("acme") });
    await d.start();
    try {
      const res = await udsCall(sock, { type: "foo", id: "1" });
      expect(res).toEqual({ type: "result", id: "1", ok: false, error: "unsupported request type foo" });
    } finally {
      await d.stop();
    }
  });
});

describe("Daemon request ids and portals", () => {
  it("drops a request whose id is not a string without replying, and keeps serving", async () => {
    const sock = sockIn();
    const d = new Daemon({ port: 0, token: "t", sockPath: sock, portals: twoPortals, ...opDefaults("acme") });
    await d.start();
    try {
      // One connection, two frames: the only reply must belong to the second one.
      const replies = await new Promise<unknown[]>((resolve, reject) => {
        const c = connect(sock);
        const dec = new FrameDecoder();
        const got: unknown[] = [];
        c.on("connect", () => {
          c.write(encodeFrame({ type: "status", id: 1 }));
          c.write(encodeFrame({ type: "call", id: 2 }));
          c.write(encodeFrame({ type: "status", id: "3" }));
        });
        c.on("data", (chunk) => { got.push(...dec.push(chunk)); });
        c.on("error", reject);
        setTimeout(() => { c.end(); resolve(got); }, 150);
      });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ type: "result", id: "3", ok: true });
    } finally {
      await d.stop();
    }
  });

  it("treats an empty portal on an op frame as the default portal", async () => {
    const sock = sockIn();
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, portals: twoPortals,
      ...opDefaults("beta"), registry: createRegistry([whereOp]),
    });
    await d.start();
    try {
      await fakeExtension(d.port, "https://beta.bitrix24.ru");
      await new Promise((r) => setTimeout(r, 50));

      const res = await udsCall(sock, { type: "op", id: "1", portal: "", op: "where", args: {} });
      expect(res.ok).toBe(true);
      expect(res.data.portal).toBe("beta");
    } finally {
      await d.stop();
    }
  });
});
