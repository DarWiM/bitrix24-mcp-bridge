// src/bridge/uds-client.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { WebSocket } from "ws";
import { encodeFrame, FrameDecoder } from "./frame.js";
import { Daemon } from "./daemon.js";
import { UdsClient, requestDaemonShutdown } from "./uds-client.js";
import { z } from "zod";
import { createRegistry } from "../ops/registry.js";
import { defineOperation } from "../ops/operation.js";

const opDefaults = (defaultPortal: string) => ({ defaultPortal, downloadsDir: tmpdir(), allowMutations: true });

function startFakeUdsServer(
  sockPath: string,
  onMessage: (msg: any, sock: Socket) => void,
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      const dec = new FrameDecoder();
      sock.on("data", (chunk) => {
        for (const msg of dec.push(chunk)) onMessage(msg, sock);
      });
    });
    server.listen(sockPath, () => resolve(server));
  });
}

describe("UdsClient", () => {
  it("connects to a running daemon and proxies a call", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const d = new Daemon({ port: 0, token: "t", sockPath: sock, portals: { acme: { origin: "https://acme.bitrix24.ru" } }, ...opDefaults("acme") });
    await d.start();

    const ws = new WebSocket(`ws://127.0.0.1:${d.port}`, { headers: { origin: "https://acme.bitrix24.ru" } });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: "t" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "call") ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: 42 }));
    });
    await new Promise((r) => setTimeout(r, 50));

    const client = new UdsClient({ sockPath: sock });
    await client.connect();
    const res = await client.call("acme", { endpoint: "/x", action: null, method: "POST", params: {} });
    expect(res).toBe(42);
    client.close();
    await d.stop();
  });

  it("op() round-trips an operation through a running daemon", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const echo = defineOperation({
      name: "echo", description: "test", mutating: false, input: { n: z.number() },
      run: async (ctx, a) => ({ portal: ctx.portal, n: a.n, reply: await ctx.call({ endpoint: "/x", action: null, method: "POST", params: {} }) }),
    });
    const d = new Daemon({
      port: 0, token: "t", sockPath: sock, portals: { acme: { origin: "https://acme.bitrix24.ru" } },
      ...opDefaults("acme"), registry: createRegistry([echo]),
    });
    await d.start();

    const ws = new WebSocket(`ws://127.0.0.1:${d.port}`, { headers: { origin: "https://acme.bitrix24.ru" } });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: "t" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "call") ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: 42 }));
    });
    await new Promise((r) => setTimeout(r, 50));

    const client = new UdsClient({ sockPath: sock });
    await client.connect();
    try {
      expect(await client.op(undefined, "echo", { n: 7 })).toEqual({ portal: "acme", n: 7, reply: 42 });
      const err = await client.op("acme", "echo", { n: "x" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/invalid arguments for echo/);
    } finally {
      client.close();
      await d.stop();
    }
  });

  it("op() gives download operations the long timeout and everything else the regular one", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const received: any[] = [];
    const server = await startFakeUdsServer(sock, (msg, s) => {
      received.push(msg);
      setTimeout(() => s.write(encodeFrame({ type: "result", id: msg.id, ok: true, data: msg.op })), 150);
    });

    const client = new UdsClient({ sockPath: sock, requestTimeoutMs: 50 });
    await client.connect();
    try {
      await expect(client.op(undefined, "task_get", { taskId: 1 })).rejects.toThrow(/did not respond to op in 50ms/);
      expect(await client.op("acme", "file_download", { url: "/x" })).toBe("file_download");
      expect(await client.op("acme", "call_recording", { callId: 1 })).toBe("call_recording");
      expect(received[0]).toEqual({ id: received[0].id, type: "op", op: "task_get", args: { taskId: 1 } });
      expect(received[1]).toMatchObject({ type: "op", portal: "acme", op: "file_download" });
    } finally {
      client.close();
      server.close();
    }
  });

  it("spawns the daemon when none is running", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    let started: Daemon | undefined;
    const client = new UdsClient({
      sockPath: sock,
      spawnDaemon: () => {
        started = new Daemon({ port: 0, token: "t", sockPath: sock, portals: { d: { origin: "https://d.bitrix24.ru" } }, ...opDefaults("d") });
        started.start();
      },
      connectTimeoutMs: 3000,
    });
    await client.connect();       // must not throw — daemon comes up
    client.close();
    await started!.stop();
  });

  it("status() round-trips a status request and resolves with the portals payload", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const d = new Daemon({ port: 0, token: "t", sockPath: sock, portals: { acme: { origin: "https://acme.bitrix24.ru" } }, ...opDefaults("acme") });
    await d.start();

    const client = new UdsClient({ sockPath: sock });
    await client.connect();
    try {
      const res = await client.status();
      expect(res.portals).toEqual([{ alias: "acme", origin: "https://acme.bitrix24.ru", connected: false, extensionVersion: null }]);
      expect(typeof res.version).toBe("string");
    } finally {
      client.close();
      await d.stop();
    }
  });

  it("resolves concurrent call() and status() whose replies arrive out of order", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const received: any[] = [];
    const server = await startFakeUdsServer(sock, (msg, s) => {
      received.push(msg);
      if (received.length === 2) {
        // reply in reverse order: the second request received gets answered first
        for (const m of [received[1], received[0]]) {
          const data = m.type === "status" ? { portals: [], version: "1.2.3" } : "call-payload";
          s.write(encodeFrame({ type: "result", id: m.id, ok: true, data }));
        }
      }
    });

    const client = new UdsClient({ sockPath: sock });
    await client.connect();
    try {
      const callPromise = client.call("acme", { endpoint: "/x", action: null, method: "POST", params: {} });
      const statusPromise = client.status();

      const [callRes, statusRes] = await Promise.all([callPromise, statusPromise]);
      expect(callRes).toBe("call-payload");
      expect(statusRes).toEqual({ portals: [], version: "1.2.3" });
    } finally {
      client.close();
      server.close();
    }
  });

  it("rejects both a pending call() and a pending status() when the socket closes", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const server = await startFakeUdsServer(sock, () => { /* never reply */ });

    const client = new UdsClient({ sockPath: sock });
    await client.connect();

    const callPromise = client.call("acme", { endpoint: "/x", action: null, method: "POST", params: {} });
    const statusPromise = client.status();
    // Attach catch handlers before close() so a same-tick rejection is never "unhandled".
    const callCaught = callPromise.catch((e: unknown) => e);
    const statusCaught = statusPromise.catch((e: unknown) => e);

    client.close(); // destroys the socket -> both pending entries must reject

    const [callErr, statusErr] = await Promise.all([callCaught, statusCaught]);
    expect(callErr).toBeInstanceOf(Error);
    expect((callErr as Error).message).toMatch(/daemon connection closed/);
    expect(statusErr).toBeInstanceOf(Error);
    expect((statusErr as Error).message).toMatch(/daemon connection closed/);

    server.close();
  });

  it("rejects status() via its timeout when the daemon never replies", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const server = await startFakeUdsServer(sock, () => { /* accepts but never answers */ });

    const client = new UdsClient({ sockPath: sock, requestTimeoutMs: 50 });
    await client.connect();
    try {
      await expect(client.status()).rejects.toThrow(/daemon did not respond to status in 50ms/);
    } finally {
      client.close();
      server.close();
    }
  });
});

describe("requestDaemonShutdown", () => {
  it("resolves true when the daemon replies to the shutdown frame", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const server = await startFakeUdsServer(sock, (msg, s) => {
      if (msg.type === "shutdown") s.write(encodeFrame({ type: "result", id: msg.id, ok: true, data: { stopping: true } }));
    });
    try {
      await expect(requestDaemonShutdown(sock)).resolves.toBe(true);
    } finally {
      server.close();
    }
  });

  it("resolves false (never throws) when no daemon is listening", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "no-daemon.sock");
    await expect(requestDaemonShutdown(sock, 200)).resolves.toBe(false);
  });

  it("resolves false when the peer replies with a mismatched id instead of acking", async () => {
    // A stray/unrelated frame (wrong id) must never masquerade as a confirmed shutdown.
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const server = await startFakeUdsServer(sock, (msg, s) => {
      s.write(encodeFrame({ type: "result", id: "not-the-real-id", ok: true, data: {} }));
      s.end();
    });
    try {
      await expect(requestDaemonShutdown(sock, 300)).resolves.toBe(false);
    } finally {
      server.close();
    }
  });

  it("resolves false and does not throw uncaught when the peer sends a malformed frame", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const server = createServer((s) => {
      s.on("data", () => { s.write("not json\n"); s.end(); });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));

    let uncaught: unknown;
    const onUncaught = (e: unknown) => { uncaught = e; };
    process.on("uncaughtException", onUncaught);

    const result = await requestDaemonShutdown(sock, 300);

    process.off("uncaughtException", onUncaught);
    expect(uncaught).toBeUndefined();
    expect(result).toBe(false);

    server.close();
  });
});

describe("UdsClient error resilience", () => {
  it("does not throw uncaught when the server destroys the socket with an error", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    let serverSock: Socket | undefined;
    const server = createServer((s) => {
      serverSock = s;
      s.on("error", () => {}); // server-side socket also emits 'error' on destroy(err); not under test
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));

    let uncaught: unknown;
    const onUncaught = (e: unknown) => { uncaught = e; };
    process.on("uncaughtException", onUncaught);

    const client = new UdsClient({ sockPath: sock });
    await client.connect();
    const callPromise = client.call("acme", { endpoint: "/x", action: null, method: "POST", params: {} }).catch((e) => e);

    // Simulate an abrupt daemon death on an already-connected client socket.
    serverSock!.destroy(new Error("simulated ECONNRESET"));
    await new Promise((r) => setTimeout(r, 100));
    process.off("uncaughtException", onUncaught);

    expect(uncaught).toBeUndefined();
    const err = await callPromise;
    expect(err).toBeInstanceOf(Error);

    client.close();
    server.close();
  });
});
