// src/bridge/uds-client.test.ts
import { describe, it, expect, mock } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { WebSocket } from "ws";
import { encodeFrame, FrameDecoder } from "./frame.js";
import { Daemon } from "./daemon.js";
import { UdsClient, replaceStaleDaemon, requestDaemonShutdown, stopDaemon } from "./uds-client.js";
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

  it("resolves concurrent op() and status() whose replies arrive out of order", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const received: any[] = [];
    const server = await startFakeUdsServer(sock, (msg, s) => {
      received.push(msg);
      if (received.length === 2) {
        // reply in reverse order: the second request received gets answered first
        for (const m of [received[1], received[0]]) {
          const data = m.type === "status" ? { portals: [], version: "1.2.3" } : "op-payload";
          s.write(encodeFrame({ type: "result", id: m.id, ok: true, data }));
        }
      }
    });

    const client = new UdsClient({ sockPath: sock });
    await client.connect();
    try {
      const opPromise = client.op("acme", "task_get", { taskId: 1 });
      const statusPromise = client.status();

      const [opRes, statusRes] = await Promise.all([opPromise, statusPromise]);
      expect(opRes).toBe("op-payload");
      expect(statusRes).toEqual({ portals: [], version: "1.2.3" });
    } finally {
      client.close();
      server.close();
    }
  });

  it("rejects both a pending op() and a pending status() when the socket closes", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const server = await startFakeUdsServer(sock, () => { /* never reply */ });

    const client = new UdsClient({ sockPath: sock });
    await client.connect();

    const opPromise = client.op("acme", "task_get", { taskId: 1 });
    const statusPromise = client.status();
    // Attach catch handlers before close() so a same-tick rejection is never "unhandled".
    const opCaught = opPromise.catch((e: unknown) => e);
    const statusCaught = statusPromise.catch((e: unknown) => e);

    client.close(); // destroys the socket -> both pending entries must reject

    const [opErr, statusErr] = await Promise.all([opCaught, statusCaught]);
    expect(opErr).toBeInstanceOf(Error);
    expect((opErr as Error).message).toMatch(/daemon connection closed/);
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
    const opPromise = client.op("acme", "task_get", { taskId: 1 }).catch((e) => e);

    // Simulate an abrupt daemon death on an already-connected client socket.
    serverSock!.destroy(new Error("simulated ECONNRESET"));
    await new Promise((r) => setTimeout(r, 100));
    process.off("uncaughtException", onUncaught);

    expect(uncaught).toBeUndefined();
    const err = await opPromise;
    expect(err).toBeInstanceOf(Error);

    client.close();
    server.close();
  });
});

describe("stopDaemon", () => {
  it("resolves true once the daemon has stopped and its socket is gone", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const d = new Daemon({ port: 0, token: "t", sockPath: sock, portals: { acme: { origin: "https://acme.bitrix24.ru" } }, ...opDefaults("acme") });
    await d.start();

    await expect(stopDaemon(sock)).resolves.toBe(true);
    expect(existsSync(sock)).toBe(false);
  });

  it("resolves true at once when nothing is at the socket path", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    await expect(stopDaemon(sock, 200)).resolves.toBe(true);
  });

  it("resolves false when the socket path stays in place", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    writeFileSync(sock, "");
    await expect(stopDaemon(sock, 200)).resolves.toBe(false);
  });
});

describe("replaceStaleDaemon", () => {
  // Each status() answers with the next entry; an Error entry rejects.
  function fakeClient(...answers: Array<string | Error>) {
    const calls: string[] = [];
    const timeouts: Array<number | undefined> = [];
    const client = {
      status: mock(async (timeoutMs?: number) => {
        calls.push("status");
        timeouts.push(timeoutMs);
        const next = answers.shift() ?? new Error("no more answers");
        if (next instanceof Error) throw next;
        return { portals: [], version: next };
      }),
      close: mock(() => { calls.push("close"); }),
      connect: mock(async () => { calls.push("connect"); }),
    };
    return { client, calls, timeouts };
  }

  it("stops a daemon of another version and reconnects to a fresh one", async () => {
    const { client, calls, timeouts } = fakeClient("0.4.0", "0.5.0");
    const stop = mock(async () => { calls.push("stop"); return true; });
    const log = mock((_line: string) => {});

    await replaceStaleDaemon(client, { version: "0.5.0", enabled: true, stopDaemon: stop, log });

    expect(calls).toEqual(["status", "stop", "close", "connect", "status"]);
    expect(timeouts).toEqual([3000, 3000]);
    expect(log).toHaveBeenCalledWith("[mcp] restarted daemon 0.4.0 → 0.5.0");
  });

  it("keeps a daemon of the same version", async () => {
    const { client, calls } = fakeClient("0.5.0");
    const stop = mock(async () => true);

    await replaceStaleDaemon(client, { version: "0.5.0", enabled: true, stopDaemon: stop, log: () => {} });

    expect(calls).toEqual(["status"]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("leaves the daemon alone in a dev build", async () => {
    const { client, calls } = fakeClient("0.4.0");
    const stop = mock(async () => true);

    await replaceStaleDaemon(client, { version: "0.0.0-dev", enabled: false, stopDaemon: stop, log: () => {} });

    expect(calls).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("reconnects even when the stop was not confirmed, since another client may have stopped it first", async () => {
    const { client, calls } = fakeClient("0.4.0", "0.5.0");
    const log = mock((_line: string) => {});

    await replaceStaleDaemon(client, { version: "0.5.0", enabled: true, stopDaemon: async () => false, log });

    expect(calls).toEqual(["status", "close", "connect", "status"]);
    expect(log).toHaveBeenCalledWith("[mcp] restarted daemon 0.4.0 → 0.5.0");
  });

  it("says so when the old daemon is still there after the attempt", async () => {
    const { client } = fakeClient("0.4.0", "0.4.0");
    const log = mock((_line: string) => {});

    await replaceStaleDaemon(client, { version: "0.5.0", enabled: true, stopDaemon: async () => false, log });

    expect(log).toHaveBeenCalledWith("[mcp] daemon is still 0.4.0 after a restart attempt (expected 0.5.0)");
  });

  it("treats a daemon that does not answer the version check as stale", async () => {
    const { client, calls } = fakeClient(new Error("daemon did not respond to status in 3000ms"), "0.5.0");
    const log = mock((_line: string) => {});

    await replaceStaleDaemon(client, { version: "0.5.0", enabled: true, stopDaemon: async () => true, log });

    expect(calls).toEqual(["status", "close", "connect", "status"]);
    expect(log).toHaveBeenCalledWith("[mcp] daemon did not answer the version check (daemon did not respond to status in 3000ms); restarting it");
    expect(log).toHaveBeenCalledWith("[mcp] restarted daemon unresponsive → 0.5.0");
  });

  it("reports a respawned daemon it cannot reach without throwing", async () => {
    const { client } = fakeClient("0.4.0");
    client.connect.mockImplementation(async () => { throw new Error("could not reach daemon at /x.sock"); });
    const log = mock((_line: string) => {});

    await replaceStaleDaemon(client, { version: "0.5.0", enabled: true, stopDaemon: async () => true, log });

    expect(log).toHaveBeenCalledWith("[mcp] could not reach the respawned daemon: could not reach daemon at /x.sock");
  });

  it("gives up on a daemon that never answers within the short timeout", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const server = await startFakeUdsServer(sock, () => { /* never answers */ });
    const client = new UdsClient({ sockPath: sock });
    await client.connect();
    const log = mock((_line: string) => {});
    try {
      const started = Date.now();
      await replaceStaleDaemon(client, { version: "0.5.0", enabled: true, stopDaemon: async () => false, log, statusTimeoutMs: 100 });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(log).toHaveBeenCalledWith("[mcp] daemon did not answer the version check (daemon did not respond to status in 100ms); restarting it");
      expect(log).toHaveBeenCalledWith("[mcp] daemon is still unresponsive after a restart attempt (expected 0.5.0)");
    } finally {
      client.close();
      server.close();
    }
  });

  it("recovers when another client's stop already took this connection down", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const portals = { acme: { origin: "https://acme.bitrix24.ru" } };
    const old = new Daemon({ port: 0, token: "t", sockPath: sock, portals, ...opDefaults("acme") });
    await old.start();
    const port = old.port;
    let fresh: Daemon | undefined;
    const client = new UdsClient({
      sockPath: sock,
      spawnDaemon: () => {
        fresh = new Daemon({ port, token: "t", sockPath: sock, portals, ...opDefaults("acme") });
        void fresh.start();
      },
      connectTimeoutMs: 3000,
    });
    await client.connect();
    try {
      // The other client wins: the daemon goes away with our connection, and our own stop gets no ack.
      const stopLost = async () => { await old.stop(); return false; };
      await replaceStaleDaemon(client, { version: "9.9.9", enabled: true, stopDaemon: stopLost, log: () => {} });

      expect(fresh).toBeDefined();
      const res = await client.status();
      expect(res.portals).toHaveLength(1);
    } finally {
      client.close();
      await fresh?.stop();
      await old.stop();
    }
  });

  it("hands the client over to a daemon respawned on the same port and socket", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const portals = { acme: { origin: "https://acme.bitrix24.ru" } };
    const old = new Daemon({ port: 0, token: "t", sockPath: sock, portals, ...opDefaults("acme") });
    await old.start();
    // Read now: a stopped bridge no longer knows the port it was bound to.
    const port = old.port;
    let fresh: Daemon | undefined;
    const client = new UdsClient({
      sockPath: sock,
      spawnDaemon: () => {
        fresh = new Daemon({ port, token: "t", sockPath: sock, portals, ...opDefaults("acme") });
        void fresh.start();
      },
      connectTimeoutMs: 3000,
    });
    await client.connect();
    try {
      await replaceStaleDaemon(client, { version: "9.9.9", enabled: true, stopDaemon: () => stopDaemon(sock), log: () => {} });

      expect(fresh?.port).toBe(port);
      const res = await client.status();
      expect(res.portals).toHaveLength(1);
    } finally {
      client.close();
      await fresh?.stop();
      await old.stop();
    }
  });
});
